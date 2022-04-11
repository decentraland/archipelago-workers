import { IslandUpdates, PeerPositionChange } from "@dcl/archipelago"
import { JSONCodec } from "nats"
import { GlobalContext } from "../types"

const jsonCodec = JSONCodec()

export function setupTopics(globalContext: GlobalContext): void {
  const messageBroker = globalContext.components.messageBroker
  const archipelago = globalContext.components.archipelago

  messageBroker.subscribe("heartbeat", (data: Uint8Array) => {
    const peerPositionChange = jsonCodec.decode(data) as PeerPositionChange
    archipelago.setPeersPositions(peerPositionChange)
  })

  archipelago.subscribeToUpdates((updates: IslandUpdates) => {
    if (Object.keys(updates).length) {
      messageBroker.publish("island_updates", updates)
    }
  })
}
