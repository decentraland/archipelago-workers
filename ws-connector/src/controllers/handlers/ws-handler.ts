import { ClientPacket, Heartbeat } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { upgradeWebSocketResponse } from '@well-known-components/http-server/dist/ws'
import { craftMessage } from '../../logic/craft-message'
import { handleSocketLinearProtocol } from '../../logic/handle-linear-protocol'
import { HandlerContextWithPath, InternalWebSocket } from '../../types'

export async function websocketHandler(
  context: HandlerContextWithPath<'config' | 'logs' | 'ethereumProvider' | 'peersRegistry' | 'nats', '/ws'>
) {
  const { logs, peersRegistry, nats } = context.components
  const logger = logs.getLogger('Websocket Handler')

  logger.debug('Websocket requested ')
  return upgradeWebSocketResponse((socket) => {
    const ws = socket as any as InternalWebSocket

    ws.on('error', (error) => {
      logger.error('ws-error')
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

        ws.on('close', () => {
          if (ws.address) {
            peersRegistry.onPeerDisconnected(ws.address)
            nats.publish(`peer.${ws.address}.disconnect`)
          }
        })

        ws.on('message', (data) => {
          const { message } = ClientPacket.decode(Buffer.from(data))
          if (!message) {
            return
          }
          switch (message.$case) {
            case 'heartbeat': {
              nats.publish(`peer.${ws.address!}.heartbeat`, Heartbeat.encode(message.heartbeat).finish())
              break
            }
          }
        })
      })
      .catch((err: any) => {
        logger.error(err)
        try {
          ws.end()
        } catch {}
      })
  })
}
