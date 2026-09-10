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

export async function registerWsHandler(
  components: Pick<
    AppComponents,
    | 'config'
    | 'logs'
    | 'ethereumProvider'
    | 'peersRegistry'
    | 'banChecker'
    | 'denyList'
    | 'supersedeCooldown'
    | 'nats'
    | 'server'
    | 'metrics'
  >
) {
  const {
    logs,
    peersRegistry,
    banChecker,
    denyList,
    supersedeCooldown,
    nats,
    server,
    config,
    ethereumProvider,
    metrics
  } = components
  const logger = logs.getLogger('Websocket Handler')

  const timeout_ms = (await config.getNumber('HANDSHAKE_TIMEOUT')) || 60 * 1000 // 1 min

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

  server.app.ws<WsUserData>('/ws', {
    idleTimeout: 90,
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

              // Almost certainly the session kicked a moment ago, coming straight back to
              // retake the slot. Refuse it so the session that superseded it still holds the
              // address when the island assignment for it arrives; the client retries on its
              // own recovery interval.
              //
              // Keep this below the last await. Read earlier, a concurrent handshake could
              // arm a cooldown in the gap before the register below and this one would miss
              // it — the ban check alone is an uncached HTTP call.
              if (supersedeCooldown.isCoolingDown(address)) {
                metrics.increment('dcl_ws_connector_supersede_cooldown_refusals_total')
                logger.warn(`Rejected reconnect during supersede cooldown: ${address}`)
                safeEndWebSocket(ws, { code: 1013, message: Buffer.from('Try again later') })
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
                  // Only a socket that has not been reaped yet. That is weaker than liveness:
                  // `isClosed` is set from the close callback, so a client that vanished
                  // without a FIN still reads as open until uWS's idleTimeout, and its own
                  // reconnect arms a window against itself. Bounded — it costs that client one
                  // refusal only if it drops again inside the window — and the alternative,
                  // inferring liveness from heartbeat age, cannot separate the two cases: a
                  // client reconnects fast enough that the dead socket's last heartbeat is no
                  // older than a live one's.
                  supersedeCooldown.onSuperseded(address)
                }
                safeEndWebSocket(previousWs)
              }

              peersRegistry.onPeerConnected(address, ws)

              // Set address and stage BEFORE sending welcome so the close handler
              // can clean up the registry if the send fails
              changeStage(ws.getUserData(), {
                stage: Stage.HANDSHAKE_COMPLETED,
                address
              })

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

              // Announces that this address now has a live session. Island assignments come
              // from Pulse's cluster feed, which is silent while a peer's cluster is unchanged,
              // so without this a client that reconnects standing still is never told which
              // island to join and waits forever. Archipelago Core covered the same case by
              // forgetting the peer on disconnect and re-creating it on the next heartbeat.
              nats.publish(`peer.${address}.connect`)

              logger.debug(`Welcome sent`, { address })
            } else {
              logger.warn(`Authentication failed`, { message: result.message } as any)
              safeEndWebSocket(ws)
            }
            break
          }
          case Stage.HANDSHAKE_COMPLETED: {
            if (packet.message && packet.message.$case === 'heartbeat') {
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
        peersRegistry.onPeerDisconnected(data.address, ws)
        nats.publish(`peer.${data.address}.disconnect`)
      }
    }
  })
}
