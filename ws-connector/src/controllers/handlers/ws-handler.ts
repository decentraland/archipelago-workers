import { randomBytes } from 'node:crypto'
import { ClientPacket, Heartbeat } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { craftKickedMessage, craftMessage } from '../../logic/craft-message'
import { AppComponents, InternalWebSocket, WsUserData, Stage } from '../../types'
import { EthAddress, AuthChain } from '@dcl/schemas'
import { normalizeAddress } from '../../logic/address'
import { sessionKeyOf } from '../../logic/session'
import { getErrorMessage } from '../../logic/errors'
import { safeEndWebSocket, SendResult } from '../../logic/websocket'
import { Authenticator } from '@dcl/crypto'
import { onRequestEnd, onRequestStart } from '@dcl/uws-http-server'

// µWebSockets' own default. Above this many bytes of undrained frames on one socket, the next
// send is dropped (SendResult.DROPPED) instead of queued, which is what lets the island feed
// tell a stalled reader apart from a slow one. Every frame this service sends must fit under it
// with room to spare; an island assignment is about a kilobyte.
const DEFAULT_MAX_BACKPRESSURE_BYTES = 64 * 1024

export async function registerWsHandler(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'ethereumProvider' | 'peersRegistry' | 'banChecker' | 'denyList' | 'nats' | 'server' | 'metrics'
  >
) {
  const { logs, peersRegistry, banChecker, denyList, nats, server, config, ethereumProvider, metrics } = components
  const logger = logs.getLogger('Websocket Handler')

  const timeout_ms = (await config.getNumber('HANDSHAKE_TIMEOUT')) || 60 * 1000 // 1 min
  const maxBackpressureBytes = (await config.getNumber('WS_MAX_BACKPRESSURE_BYTES')) || DEFAULT_MAX_BACKPRESSURE_BYTES

  function startTimeoutHandler(ws: InternalWebSocket) {
    const data = ws.getUserData()
    data.timeout = setTimeout(() => {
      logger.debug(`Terminating socket in stage: ${data.stage} because of timeout`)
      safeEndWebSocket(ws, logger)
    }, timeout_ms)
  }

  function changeStage(data: WsUserData, newData: WsUserData) {
    Object.assign(data, newData)
  }

  server.app.ws<WsUserData>('/ws', {
    idleTimeout: 90,
    maxBackpressure: maxBackpressureBytes,
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
        safeEndWebSocket(ws, logger, { code: 1007, message: Buffer.from('Cannot decode ClientPacket') })
        return
      }

      try {
        switch (userData.stage) {
          case Stage.HANDSHAKE_START: {
            if (!packet.message || packet.message.$case !== 'challengeRequest') {
              logger.debug('Invalid protocol. challengeRequest packet missed')
              safeEndWebSocket(ws, logger)
              return
            }
            if (!EthAddress.validate(packet.message.challengeRequest.address)) {
              logger.debug('Invalid protocol. challengeRequest has an invalid address')
              safeEndWebSocket(ws, logger)
              return
            }
            const address = normalizeAddress(packet.message.challengeRequest.address)
            if (await denyList.isDenylisted(address)) {
              logger.warn(`Rejected connection from deny-listed wallet: ${address}`)
              safeEndWebSocket(ws, logger)
              return
            }

            const challengeToSign = 'dcl-' + randomBytes(32).toString('hex')
            const alreadyConnected = peersRegistry.hasPeer(address)
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

            // SENT only, unlike the island feed's QUEUED-or-SENT: a handshake frame is a few dozen
            // bytes, so one that is merely queued means the client is not reading before it has
            // even authenticated, and waiting on it would hold a slot for a dead peer.
            if (ws.send(challengeMessage, true) !== SendResult.SENT) {
              logger.error('Closing connection: cannot send challenge')
              safeEndWebSocket(ws, logger)
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
              safeEndWebSocket(ws, logger)
              return
            }

            const authChain = JSON.parse(packet.message.signedChallenge.authChainJson)
            if (!AuthChain.validate(authChain)) {
              logger.debug('Invalid auth chain')
              safeEndWebSocket(ws, logger)
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
                safeEndWebSocket(ws, logger)
                return
              }

              // Reject platform-banned users so they can't establish a comms session. The
              // explorer shows its user-banned notification off the SNS event, which arrives
              // separately; the kick reason itself carries no ban semantics (craftKickedMessage).
              if (await banChecker.isBanned(address)) {
                logger.warn(`Rejected connection from platform-banned wallet: ${address}`)
                ws.send(craftKickedMessage(), true)
                safeEndWebSocket(ws, logger)
                return
              }

              // The device's ephemeral address: what the island feed is addressed to. Another
              // device of the same wallet has a different one and is left alone.
              const session = sessionKeyOf(authChain)

              // A socket already held for this exact (address, session) is this device's own
              // zombie — a reconnect after a drop the server has not noticed yet. Only a socket
              // that has not been reaped counts: `isClosed` is set from the close callback.
              const previousWs = peersRegistry.getPeerWs(address, session)
              if (previousWs) {
                if (!previousWs.getUserData().isClosed) {
                  logger.debug("Replacing this device's previous socket")
                  if (previousWs.send(craftKickedMessage(), true) !== SendResult.SENT) {
                    logger.error('Closing connection: cannot send kicked message')
                  }
                }
                safeEndWebSocket(previousWs, logger)
              }

              // Stage, address and session are set BEFORE the socket is reachable: the close
              // handler needs both to clean up if the welcome fails.
              changeStage(ws.getUserData(), {
                stage: Stage.HANDSHAKE_COMPLETED,
                address,
                session
              })
              peersRegistry.onPeerConnected(address, session, ws)

              const welcomeMessage = craftMessage({
                message: {
                  $case: 'welcome',
                  welcome: { peerId: address }
                }
              })

              // SENT only, as for the challenge above.
              if (ws.send(welcomeMessage, true) !== SendResult.SENT) {
                logger.error('Closing connection: cannot send welcome')
                safeEndWebSocket(ws, logger)
                return
              }

              // Announces that this session now has a live socket, so comms-gatekeeper can
              // re-announce the wallet's island to it. Island assignments come from Pulse's
              // cluster feed, which is silent while a peer's cluster is unchanged, so without
              // this a client that reconnects standing still is never told which island to join.
              nats.publish(`peer.${address}.connect`, Buffer.from(session, 'utf8'))

              logger.debug(`Welcome sent`, { address })
            } else {
              logger.warn(`Authentication failed`, { message: result.message } as any)
              safeEndWebSocket(ws, logger)
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
        safeEndWebSocket(ws, logger)
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
      if (data.address && data.session) {
        peersRegistry.onPeerDisconnected(data.address, data.session, ws)
      }
      if (data.address) {
        nats.publish(`peer.${data.address}.disconnect`)
      }
    }
  })
}
