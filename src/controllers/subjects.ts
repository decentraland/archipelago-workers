import { IMessageBrokerComponent } from "../ports/message-broker"
import { pongHandler } from "./handlers/subjects-handler"

export function setupSubjects(messageBroker: IMessageBrokerComponent): void {
  messageBroker.subscribe("pong", pongHandler)
}
