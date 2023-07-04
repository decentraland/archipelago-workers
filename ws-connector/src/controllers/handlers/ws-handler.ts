import { ClientPacket, Heartbeat } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { upgradeWebSocketResponse } from '@well-known-components/http-server/dist/ws'
import { craftMessage } from '../../logic/craft-message'
import { handleSocketLinearProtocol } from '../../logic/handle-linear-protocol'
import { HandlerContextWithPath, Stage, InternalWebSocket } from '../../types'

export async function websocketHandler(
  context: HandlerContextWithPath<'config' | 'logs' | 'ethereumProvider' | 'peersRegistry' | 'nats', '/ws'>
) {
  const { logs, peersRegistry, nats } = context.components
  const logger = logs.getLogger('Websocket Handler')

  return upgradeWebSocketResponse((socket) => {
    logger.debug('Websocket connected')
    const ws = socket as any as InternalWebSocket
    ws.stage = Stage.HANDSHAKE

    ws.on('error', (error) => {
      logger.error(error)
      try {
        ws.end()
      } catch {}
    })

    ws.on('close', () => {
      logger.debug('Websocket closed')
    })

    handleSocketLinearProtocol(context.components, ws)
      .then(() => {
        peersRegistry.onPeerConnected(ws.address!, ws)

        const welcomeMessage = craftMessage({
          message: {
            $case: 'welcome',
            welcome: { peerId: ws.address! }
          }
        })
        if (ws.send(welcomeMessage, true) !== 1) {
          logger.error('Closing connection: cannot send welcome')
          ws.close()
          return
        }

        logger.debug(`Welcome sent`, { address: ws.address! })
        ws.stage = Stage.READY

        ws.on('close', () => {
          if (ws.address) {
            peersRegistry.onPeerDisconnected(ws.address)
            nats.publish(`archipelago.peer.${ws.address}.disconnect`)
          }
        })

        ws.on('message', (data) => {
          switch (ws.stage) {
            case Stage.HANDSHAKE: {
              ws.emit('message', Buffer.from(data))
              break
            }
            case Stage.READY: {
              const { message } = ClientPacket.decode(Buffer.from(data))
              if (!message) {
                return
              }
              switch (message.$case) {
                case 'heartbeat': {
                  const { position, desiredRoom } = message.heartbeat

                  nats.publish(
                    `archipelago.peer.${ws.address!}.heartbeat`,
                    Heartbeat.encode({
                      position,
                      desiredRoom
                    }).finish()
                  )
                  break
                }
              }
              break
            }
          }
        })
      })
      .catch((err: any) => {
        logger.info(err)
        try {
          ws.end()
        } catch {}
      })
  })
}
