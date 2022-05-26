import { IBaseComponent, IConfigComponent } from '@well-known-components/interfaces'
import { Subscription } from '../../src/ports/message-broker'
import { IMessageBrokerComponent } from '../../src/ports/message-broker'
import { BaseComponents } from '../../src/types'
import { Topic } from '../../src/ports/message-broker'
import { HeartbeatMessage } from '../../src/controllers/proto/archipelago_pb'
const { connect } = require('mock-nats-client')

export async function createLocalMessageBrokerComponent(
  components: Pick<BaseComponents, 'config' | 'logs'>
): Promise<IMessageBrokerComponent & IBaseComponent> {
  const client = connect({ preserveBuffers: true })

  function publish(topic: string, message: any): void {
    message ? client.publish(topic, message) : client.publish(topic, [])
  }

  function subscribe(topic: string, handler: Function): Subscription {
    const sid = client.subscribe(topic, (delivery, _replyTo, subject) => {
      handler({ data: delivery, topic: new Topic(subject) })
    })
    const unsubscribe = () => {
      client.unsubscribe(sid)
    }
    return { unsubscribe }
  }

  async function start() {}

  async function stop() {}

  return {
    publish,
    subscribe,
    start,
    stop
  }
}
