import { upgradeWebSocketResponse } from '@well-known-components/http-server/dist/ws'
import { IHttpServerComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { WebSocket } from 'ws'
import { GlobalContext, Transport } from '../../types'
import { v4 } from 'uuid'
import { TransportMessage } from '../proto/archipelago'
import { ITransportRegistryComponent } from '../../ports/transport-registry'
import { verify } from 'jsonwebtoken'

const PENDING_AUTH_TIMEOUT_MS = 1000

type PendingAuthRequest = {
  started: number
  resolve: (connStrs: Record<string, string>) => void
  reject: (error: Error) => void
  timeout: undefined | NodeJS.Timeout
}

export function handleUpgrade(
  logger: ILoggerComponent.ILogger,
  transportRegistry: ITransportRegistryComponent,
  ws: Pick<WebSocket, 'on' | 'send' | 'terminate' | 'ping'>,
  id: number
) {
  logger.info(`New transport Connection: ${id}`)
  const pendingAuthRequests = new Map<string, PendingAuthRequest>()

  const transport: Transport = {
    id,
    type: 'unknown',
    availableSeats: 0,
    usersCount: 0,
    maxIslandSize: 0,
    getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
      return new Promise<Record<string, string>>((resolve, reject) => {
        const requestId = v4()
        pendingAuthRequests.set(requestId, {
          started: Date.now(),
          resolve,
          reject,
          timeout: setTimeout(() => {
            const pending = pendingAuthRequests.get(requestId)
            if (pending) {
              pendingAuthRequests.delete(requestId)
              pending.reject(new Error('request timeout'))
            }
          }, PENDING_AUTH_TIMEOUT_MS)
        })

        ws.send(
          TransportMessage.encode({
            message: {
              $case: 'authRequest',
              authRequest: {
                requestId,
                userIds,
                roomId
              }
            }
          }).finish()
        )
      })
    }
  }
  ws.on('message', (message) => {
    const transportMessage = TransportMessage.decode(message as Buffer)

    switch (transportMessage.message?.$case) {
      case 'init': {
        const {
          init: { maxIslandSize, type }
        } = transportMessage.message
        transport.type = type === 0 ? 'livekit' : 'ws'
        transport.maxIslandSize = maxIslandSize
        logger.info(`New transport Connection: ${id}, type: ${type}`)
        break
      }
      case 'heartbeat': {
        const {
          heartbeat: { availableSeats, usersCount }
        } = transportMessage.message

        transport.availableSeats = availableSeats
        transport.usersCount = usersCount
        transportRegistry.onTransportHeartbeat(transport)
        break
      }
      case 'authResponse': {
        const {
          authResponse: { requestId, connStrs }
        } = transportMessage.message

        const pending = pendingAuthRequests.get(requestId)
        if (pending) {
          pendingAuthRequests.delete(requestId)
          pending.resolve(connStrs)
          if (pending.timeout) {
            clearTimeout(pending.timeout)
          }
        }
        break
      }
    }
  })

  let isAlive = true
  ws.on('pong', () => {
    isAlive = true
  })

  const pingInterval = setInterval(function ping() {
    if (isAlive === false) {
      logger.warn(`Terminating ws because of ping timeout`)
      return ws.terminate()
    }

    isAlive = false
    ws.ping()
  }, 30000)

  ws.on('error', (error) => {
    logger.error(error)
  })

  ws.on('close', () => {
    logger.info('Websocket closed')
    transportRegistry.onTransportDisconnected(transport.id)
    clearInterval(pingInterval)
  })

  return {
    transport
  }
}

export async function transportHandler(context: IHttpServerComponent.DefaultContext<GlobalContext>) {
  const {
    components: { logs, transportRegistry, config }
  } = context
  const logger = logs.getLogger('Transport Handler')
  const secret = await config.requireString('TRANSPORT_REGISTRATION_SECRET')

  const token = context.url.searchParams.get('access_token') as string

  logger.info('request to transportHandler')
  let count = 0

  return upgradeWebSocketResponse((socket) => {
    const ws = socket as any as WebSocket
    count++

    try {
      verify(token, secret) as any
    } catch (err) {
      logger.info('closing ws, access_token is invalid or not provided')
      logger.error(err as Error)
      ws.close()
      return
    }

    handleUpgrade(logger, transportRegistry, ws, count)
  })
}
