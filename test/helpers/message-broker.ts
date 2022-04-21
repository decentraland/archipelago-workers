import { IBaseComponent, IConfigComponent } from "@well-known-components/interfaces"
import { Subscription } from "nats"
import { IMessageBrokerComponent } from "../../src/ports/message-broker"
import { BaseComponents } from "../../src/types"

export async function createLocalMessageBrokerComponent(
  components: Pick<BaseComponents, "config" | "logs">
): Promise<IMessageBrokerComponent & IBaseComponent> {
  function publish(topic: string, message: any): void {}

  function subscribe(topic: string, handler: Function): void {}

  async function start() {}

  async function stop() {}

  return {
    publish,
    subscribe,
    start,
    stop,
  }
}
