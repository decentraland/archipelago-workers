import {
  ClientPacket,
  Heartbeat,
  KickedReason
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { craftMessage } from '../../logic/craft-message'
import { AppComponents, InternalWebSocket, WsUserData, Stage } from '../../types'
import { EthAddress, AuthChain } from '@dcl/schemas'
import { normalizeAddress } from '../../logic/address'
import { Authenticator } from '@dcl/crypto'
import { onRequestEnd, onRequestStart } from '@well-known-components/uws-http-server'

export async function registerWsHandler(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'ethereumProvider' | 'peersRegistry' | 'nats' | 'server' | 'metrics'
  >
) {
  const { logs, peersRegistry, nats, server, config, ethereumProvider, metrics } = components
  const logger = logs.getLogger('Websocket Handler')

  const timeout_ms = (await config.getNumber('HANDSHAKE_TIMEOUT')) || 60 * 1000 // 1 min

  async function fetchDenyList(): Promise<Set<string>> {
    try {
      const response = await fetch('https://config.decentraland.org/denylist.json')
      if (!response.ok) {
        throw new Error(`Failed to fetch deny list, status: ${response.status}`)
      }
      const data = await response.json()
      if (data.users && Array.isArray(data.users)) {
        return new Set(data.users.map((user: { wallet: string }) => normalizeAddress(user.wallet)))
      } else {
        logger.warn('Deny list is missing "users" field or it is not an array.')
        return new Set()
      }
    } catch (error) {
      logger.error(`Error fetching deny list: ${(error as Error).message}`)
      return new Set()
    }
  }

  function startTimeoutHandler(ws: InternalWebSocket) {
    const data = ws.getUserData()
    data.timeout = setTimeout(() => {
      try {
        logger.debug(`Terminating socket in stage: ${data.stage} because of timeout`)
        ws.end()
      } catch (err) {}
    }, timeout_ms)
  }

  function changeStage(data: WsUserData, newData: WsUserData) {
    Object.assign(data, newData)
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
      logger.debug('ws open')
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
      } catch (err: any) {
        logger.error(err)
        ws.end(1007, Buffer.from('Cannot decode ClientPacket'))
        return
      }

      try {
        switch (userData.stage) {
          case Stage.HANDSHAKE_START: {
            if (!packet.message || packet.message.$case !== 'challengeRequest') {
              logger.debug('Invalid protocol. challengeRequest packet missed')
              ws.end()
              return
            }
            if (!EthAddress.validate(packet.message.challengeRequest.address)) {
              logger.debug('Invalid protocol. challengeRequest has an invalid address')
              ws.end()
              return
            }
            const address = normalizeAddress(packet.message.challengeRequest.address)
            const denyList: Set<string> = await fetchDenyList()
            if (denyList.has(address)) {
              logger.warn(`Rejected connection from deny-listed wallet: ${address}`)
              ws.end()
              return
            }

            const challengeToSign = 'dcl-' + Math.random().toString(36)
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
              ws.close()
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
              ws.end()
              return
            }

            const authChain = JSON.parse(packet.message.signedChallenge.authChainJson)
            if (!AuthChain.validate(authChain)) {
              logger.debug('Invalid auth chain')
              ws.end()
              return
            }

            const result = await Authenticator.validateSignature(userData.challengeToSign, authChain, ethereumProvider)

            if (result.ok) {
              const address = normalizeAddress(authChain[0].payload)
              logger.debug(`Authentication successful`, { address })

              const previousWs = peersRegistry.getPeerWs(address)
              if (previousWs) {
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
                previousWs.end()
              }

              peersRegistry.onPeerConnected(address, ws)

              const welcomeMessage = craftMessage({
                message: {
                  $case: 'welcome',
                  welcome: { peerId: address }
                }
              })
              if (ws.send(welcomeMessage, true) !== 1) {
                logger.error('Closing connection: cannot send welcome')
                const data = ws.getUserData()
                if (ws && data.address) {
                  ws.end()
                }
                return
              }

              logger.debug(`Welcome sent`, { address })

              changeStage(userData, {
                stage: Stage.HANDSHAKE_COMPLETED,
                address
              })
            } else {
              logger.warn(`Authentication failed`, { message: result.message } as any)
              ws.end()
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
      } catch (err: any) {
        logger.error(err)
        ws.end()
      }
    },
    close: (ws, code, _message) => {
      logger.debug(`Websocket closed ${code}`)
      const data = ws.getUserData()
      if (data.address) {
        peersRegistry.onPeerDisconnected(data.address)
        nats.publish(`peer.${data.address}.disconnect`)
      }
    }
  })
}
