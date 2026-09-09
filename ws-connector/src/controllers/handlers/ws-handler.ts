import { randomBytes } from 'node:crypto'
import {
  ClientPacket,
  Heartbeat,
  KickedReason
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { craftMessage } from '../../logic/craft-message'
import { AppComponents, InternalWebSocket, WsUserData, Stage } from '../../types'
import { EthAddress, AuthChain } from '@dcl/schemas'
import { normalizeAddress } from '../../logic/address'
import { getErrorMessage } from '../../logic/errors'
import { Authenticator } from '@dcl/crypto'
import { onRequestEnd, onRequestStart } from '@dcl/uws-http-server'

// The vocabulary `HEARTBEAT_FORWARDING_ENABLED` understands, trimmed and lower-cased. Deliberately
// symmetric: `0`/`no`/`off` turn the forwarding off because `1`/`yes`/`on` turn it on, and an
// operator who reaches for one expects the other to work. `''` is unset, or a bare key in an env
// file. Everything outside both lists reads as on and is warned about — see below.
const HEARTBEAT_FORWARDING_OFF_VALUES = ['false', '0', 'no', 'off']
const HEARTBEAT_FORWARDING_ON_VALUES = ['', 'true', '1', 'yes', 'on']

export async function registerWsHandler(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'ethereumProvider' | 'peersRegistry' | 'banChecker' | 'denyList' | 'nats' | 'server' | 'metrics'
  >
) {
  const { logs, peersRegistry, banChecker, denyList, nats, server, config, ethereumProvider, metrics } = components
  const logger = logs.getLogger('Websocket Handler')

  const timeout_ms = (await config.getNumber('HANDSHAKE_TIMEOUT')) || 60 * 1000 // 1 min

  // `??` rather than `||`: 0 is uWS's "never time out", and coercing it back to 90 would silently
  // ignore an operator who asked for exactly that.
  const idleTimeout = (await config.getNumber('WS_IDLE_TIMEOUT_SECONDS')) ?? 90

  // Iteration 2 retired the client heartbeat: `peer.*.heartbeat` and `peer.*.disconnect` have lost
  // their only consumer — archipelago-stats, now deleted from this repo. This switched the
  // republishing off ahead of deleting the code, and it stays as the writer half of that service's
  // rollback (docs/stats-decommission-runbook.md). Defaults to true —
  // today's behaviour, so a deploy that sets nothing is a no-op. Nothing else on the socket
  // depends on it.
  //
  // Read leniently, and it never throws. This is a rollback switch an operator types by hand under
  // time pressure, and `registerWsHandler` is awaited inside the Lifecycle entrypoint: a throw here
  // means the `/ws` route is never registered and every client loses its gateway over a typo.
  // So anything that is not a recognised "off" reads as on — the flag's own default and today's
  // behaviour — and an unrecognised value is warned about, so the flip that did not happen is
  // visible instead of silent. A blank value counts as unset: an env file may carry the bare key.
  const heartbeatForwardingRaw = (await config.getString('HEARTBEAT_FORWARDING_ENABLED')) ?? ''
  const heartbeatForwarding = heartbeatForwardingRaw.trim().toLowerCase()
  const heartbeatForwardingEnabled = !HEARTBEAT_FORWARDING_OFF_VALUES.includes(heartbeatForwarding)
  if (heartbeatForwardingEnabled && !HEARTBEAT_FORWARDING_ON_VALUES.includes(heartbeatForwarding)) {
    logger.warn(
      `HEARTBEAT_FORWARDING_ENABLED is set to '${heartbeatForwardingRaw}', which this key does not ` +
        `recognise; heartbeat forwarding stays ON, its default. Set it to 'false' to turn it off.`
    )
  }

  // uWS takes 0 or values >= 8 and nothing in between; given anything else it aborts route
  // registration with "idleTimeout must be either 0 or greater than 8!", which names neither the
  // key at fault nor the service, and ws-connector then crash-loops on deploy. Screen it here so
  // the operator is told what to change.
  if (idleTimeout !== 0 && idleTimeout < 8) {
    throw new Error(
      `WS_IDLE_TIMEOUT_SECONDS must be 0 (never time out, local debugging only) or at least 8: ` +
        `uWebSockets accepts nothing in between. Got ${idleTimeout}.`
    )
  }

  function startTimeoutHandler(ws: InternalWebSocket) {
    const data = ws.getUserData()
    data.timeout = setTimeout(() => {
      logger.debug(`Terminating socket in stage: ${data.stage} because of timeout`)
      safeEndWebSocket(ws)
    }, timeout_ms)
  }

  function changeStage(data: WsUserData, newData: WsUserData) {
    Object.assign(data, newData)
  }

  // `close` travels as a pair rather than two optionals: a code without a message was an
  // unreachable branch across all call sites, and leaving it in invited someone to pass one and
  // have it silently dropped. Closing with no reason at all stays the common case.
  function safeEndWebSocket(ws: InternalWebSocket, close?: { code: number; message: Buffer }) {
    const userData = ws.getUserData()
    if (!userData.isClosed) {
      try {
        userData.isClosed = true
        if (close) {
          ws.end(close.code, close.message)
        } else {
          ws.end()
        }
      } catch (error) {
        logger.error(`Error while safely ending WebSocket: ${getErrorMessage(error)}`)
      }
    }
  }

  /**
   * Announces a completed handshake so comms-gatekeeper re-emits this peer's current island.
   *
   * comms-gatekeeper publishes `engine.peer.<addr>.island_changed` only when Pulse reports a
   * cluster change, so a socket that reconnects without the crowd moving — a network blip, or the
   * explorer's own forced re-handshake after repeated LiveKit failures — receives nothing until it
   * does. archipelago-core covered that with the next client heartbeat; iteration 2 took heartbeats
   * away, so the handshake has to announce itself.
   *
   * Deliberately **not** gated by `HEARTBEAT_FORWARDING_ENABLED`. That switch retires subjects
   * nothing consumes any more; this one is what keeps reconnects working once it is off, so gating
   * them together would make the flip cost an island assignment on every reconnect.
   *
   * Never throws. `nats.publish` throws synchronously when the component was never started or the
   * connection is gone, and by the time this runs the peer is registered and the welcome is next: a
   * client with no island is degraded and re-handshakes, a client with no socket is broken.
   */
  function announcePeerConnected(address: string) {
    try {
      nats.publish(`peer.${address}.connect`)
    } catch (error) {
      logger.error(`Cannot announce the handshake on peer.${address}.connect: ${getErrorMessage(error)}`)
      metrics.increment('ws_connector_peer_connect_publish_failures_total')
    }
  }

  server.app.ws<WsUserData>('/ws', {
    idleTimeout,
    // Iteration 2 takes away the client heartbeats, which were the only client→server traffic on
    // this socket. uWS pings an otherwise idle client and the pong resets its idle timer, so a
    // connected-but-silent client stays connected and keeps receiving its island assignments.
    // This is uWS's own default; stated explicitly because the socket's survival now depends on
    // it and nothing else.
    sendPingsAutomatically: true,
    upgrade: (res, req, context) => {
      logger.debug('upgrade requested')
      const { labels, end } = onRequestStart(metrics, req.getMethod(), '/ws')
      /* This immediately calls open handler, you must not use res after this call */
      res.upgrade(
        {
          stage: Stage.HANDSHAKE_START
        },
        req.getHeader('sec-websocket-key'),
        req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'),
        context
      )
      onRequestEnd(metrics, labels, 101, end)
    },
    open: (ws) => {
      logger.debug('ws opened')
      const data = ws.getUserData()
      data.isClosed = false
      startTimeoutHandler(ws)
    },
    message: async (ws, message) => {
      const userData = ws.getUserData()
      if (userData.timeout) {
        clearTimeout(userData.timeout)
        userData.timeout = undefined
      }

      let packet: ClientPacket

      try {
        packet = ClientPacket.decode(Buffer.from(message))
      } catch (error) {
        logger.error(`Cannot decode ClientPacket: ${getErrorMessage(error)}`)
        safeEndWebSocket(ws, { code: 1007, message: Buffer.from('Cannot decode ClientPacket') })
        return
      }

      try {
        switch (userData.stage) {
          case Stage.HANDSHAKE_START: {
            if (!packet.message || packet.message.$case !== 'challengeRequest') {
              logger.debug('Invalid protocol. challengeRequest packet missed')
              safeEndWebSocket(ws)
              return
            }
            if (!EthAddress.validate(packet.message.challengeRequest.address)) {
              logger.debug('Invalid protocol. challengeRequest has an invalid address')
              safeEndWebSocket(ws)
              return
            }
            const address = normalizeAddress(packet.message.challengeRequest.address)
            if (await denyList.isDenylisted(address)) {
              logger.warn(`Rejected connection from deny-listed wallet: ${address}`)
              safeEndWebSocket(ws)
              return
            }

            const challengeToSign = 'dcl-' + randomBytes(32).toString('hex')
            const previousWs = peersRegistry.getPeerWs(address)
            const alreadyConnected = !!previousWs
            logger.debug('Generating challenge', {
              challengeToSign,
              address,
              alreadyConnected: alreadyConnected + ''
            })

            const challengeMessage = craftMessage({
              message: {
                $case: 'challengeResponse',
                challengeResponse: { alreadyConnected, challengeToSign }
              }
            })

            if (ws.send(challengeMessage, true) !== 1) {
              logger.error('Closing connection: cannot send challenge')
              safeEndWebSocket(ws)
              return
            }

            changeStage(userData, {
              stage: Stage.HANDSHAKE_CHALLENGE_SENT,
              challengeToSign
            })
            startTimeoutHandler(ws)
            break
          }
          case Stage.HANDSHAKE_CHALLENGE_SENT: {
            if (!packet.message || packet.message.$case !== 'signedChallenge') {
              logger.debug('Invalid protocol. signedChallengeForServer packet missed')
              safeEndWebSocket(ws)
              return
            }

            const authChain = JSON.parse(packet.message.signedChallenge.authChainJson)
            if (!AuthChain.validate(authChain)) {
              logger.debug('Invalid auth chain')
              safeEndWebSocket(ws)
              return
            }

            const result = await Authenticator.validateSignature(userData.challengeToSign, authChain, ethereumProvider)

            if (result.ok) {
              const address = normalizeAddress(authChain[0].payload)
              logger.debug(`Authentication successful`, { address })

              // Check deny list against the real address from the auth chain,
              // not just the claimed address from challengeRequest
              if (await denyList.isDenylisted(address)) {
                logger.warn(`Rejected connection from deny-listed wallet (post-auth): ${address}`)
                safeEndWebSocket(ws)
                return
              }

              // Reject platform-banned users so they can't establish a comms session.
              // KR_NEW_SESSION is reused as the kick reason because the protocol enum
              // currently has no KR_BANNED. The explorer treats both as "you were kicked"
              // and shows the existing user-banned notification (the SNS event arrives
              // separately). Replace with a dedicated reason if/when the protocol adds one.
              if (await banChecker.isBanned(address)) {
                logger.warn(`Rejected connection from platform-banned wallet: ${address}`)
                const kickedMessage = craftMessage({
                  message: {
                    $case: 'kicked',
                    kicked: { reason: KickedReason.KR_NEW_SESSION }
                  }
                })
                ws.send(kickedMessage, true)
                safeEndWebSocket(ws)
                return
              }

              // The awaits above — signature validation, the deny list and the out-of-process ban
              // check — can hold the handshake for hundreds of milliseconds, and the connection
              // can drop inside that window. uWS delivers `close` first, and it can only mark the
              // user data (there is no address on it yet to evict by), so the handshake then
              // resumes against a socket that is gone. Stop here rather than finish it:
              // registering it would leave an entry the close already walked past, announcing it
              // would have comms-gatekeeper mint a LiveKit token and re-emit an island for a
              // session that no longer exists — which `src/service.ts` would then try to deliver
              // on a closed socket — and the kick below would cost this wallet a live session for
              // the sake of a dead one.
              if (ws.getUserData().isClosed) {
                logger.debug('Aborting handshake: the socket closed while it was being authenticated', { address })
                return
              }

              const previousWs = peersRegistry.getPeerWs(address)
              if (previousWs) {
                const previousData = previousWs.getUserData()
                if (!previousData.isClosed) {
                  logger.debug('Sending kick message')
                  const kickedMessage = craftMessage({
                    message: {
                      $case: 'kicked',
                      kicked: { reason: KickedReason.KR_NEW_SESSION }
                    }
                  })
                  if (previousWs.send(kickedMessage, true) !== 1) {
                    logger.error('Closing connection: cannot send kicked message')
                  }
                }
                safeEndWebSocket(previousWs)
              }

              // Address and stage before the registration, not just before the welcome: the close
              // handler evicts only a peer it can find an address for, so from this line on every
              // close — the one a failed welcome triggers below included — cleans the registry up.
              changeStage(ws.getUserData(), {
                stage: Stage.HANDSHAKE_COMPLETED,
                address
              })

              peersRegistry.onPeerConnected(address, ws)

              // Registered before it is announced, so gatekeeper's re-emit cannot arrive before
              // the socket the forwarder looks up to deliver it. If the welcome below then fails,
              // the socket closes, the close handler evicts the peer, and the re-emit is dropped
              // by the forwarder for want of a socket — harmless, and the client re-handshakes.
              announcePeerConnected(address)

              const welcomeMessage = craftMessage({
                message: {
                  $case: 'welcome',
                  welcome: { peerId: address }
                }
              })

              if (ws.send(welcomeMessage, true) !== 1) {
                logger.error('Closing connection: cannot send welcome')
                safeEndWebSocket(ws)
                return
              }

              logger.debug(`Welcome sent`, { address })
            } else {
              logger.warn(`Authentication failed`, { message: result.message } as any)
              safeEndWebSocket(ws)
            }
            break
          }
          case Stage.HANDSHAKE_COMPLETED: {
            // Still decoded and accepted with forwarding off: clients on old builds keep sending
            // heartbeats, and tearing their session down over one would be worse than ignoring it.
            if (heartbeatForwardingEnabled && packet.message && packet.message.$case === 'heartbeat') {
              nats.publish(`peer.${userData.address}.heartbeat`, Heartbeat.encode(packet.message.heartbeat).finish())
            }
            break
          }
          default: {
            logger.error('Invalid stage')
            break
          }
        }
      } catch (error) {
        logger.error(`Error handling client packet: ${getErrorMessage(error)}`)
        safeEndWebSocket(ws)
      }
    },
    close: (ws, code, _message) => {
      logger.debug(`Websocket closed ${code}`)
      const data = ws.getUserData()
      data.isClosed = true
      if (data.timeout) {
        clearTimeout(data.timeout)
        data.timeout = undefined
      }
      if (data.address) {
        // The registry eviction is unconditional: `island_changed` forwarding keys off it, so it
        // has nothing to do with whether the retired subjects are still published.
        peersRegistry.onPeerDisconnected(data.address, ws)
        if (heartbeatForwardingEnabled) {
          nats.publish(`peer.${data.address}.disconnect`)
        }
      }
    }
  })
}
