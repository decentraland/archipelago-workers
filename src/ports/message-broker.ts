import { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces"
import { connect, JSONCodec } from "nats"

export declare type IMessageBrokerComponent = {
  publish(subject: string, message: any): void
  subscribe(subject: string, handler: Function, respond?: boolean): void
}

export declare type MessageBrokerComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
}

export async function createMessageBrokerComponent(
  components: MessageBrokerComponents
): Promise<IMessageBrokerComponent> {
  const { config, logs } = components
  const logger = logs.getLogger("MessageBroker")
  const jsonCodec = JSONCodec()

  // config
  const port = await config.requireNumber("NATS_SERVER_PORT")
  const host = await config.requireString("NATS_SERVER_HOST")

  const serverConfig = { servers: `${host}:${port}` }
  const server = await connect(serverConfig)

  const publish = (subject: string, message: any) => {
    server.publish(subject, jsonCodec.encode(message))
  }

  const subscribe = (subject: string, handler: Function, respond?: boolean) => {
    const subscription = server.subscribe(subject)
    ;(async () => {
      for await (const message of subscription) {
        try {
          if (message.data.length) {
            const data = jsonCodec.decode(message.data) as any
            logger.debug(`[${subscription.getProcessed()}]: ${message.subject}: ${JSON.stringify(data, null, 2)}`)
            const payload = await handler(data)
            if (respond) {
              message.respond(jsonCodec.encode(payload))
            }
          } else {
            logger.debug(`[${subscription.getProcessed()}]: ${message.subject}`)
            const payload = await handler()
            if (respond) {
              message.respond(jsonCodec.encode(payload))
            }
          }
        } catch (err: any) {
          logger.error(err)
        }
      }
    })()
  }

  const nats: IMessageBrokerComponent = {
    publish,
    subscribe,
  }

  return nats
}
