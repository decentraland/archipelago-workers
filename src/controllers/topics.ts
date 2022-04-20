import { IslandUpdates, PeerPositionChange } from "../logic/archipelago"
import { JSONCodec, StringCodec } from "nats"
import { GlobalContext } from "../types"

const jsonCodec = JSONCodec()
const stringCodec = StringCodec()

export function setupTopics(globalContext: GlobalContext): void {
  const messageBroker = globalContext.components.messageBroker
  const archipelago = globalContext.components.archipelago

  messageBroker.subscribe("peer_connect", (data: Uint8Array) => {
    const peerId = stringCodec.decode(data)
    archipelago.clearPeers(peerId)
  })

  messageBroker.subscribe("peer_disconnect", (data: Uint8Array) => {
    const peerId = stringCodec.decode(data)
    archipelago.clearPeers(peerId)
  })

  messageBroker.subscribe("heartbeat", (data: Uint8Array) => {
    const peerPositionChange = jsonCodec.decode(data) as PeerPositionChange
    archipelago.setPeersPositions(peerPositionChange)
  })

  archipelago.subscribeToUpdates((updates: IslandUpdates) => {
    if (Object.keys(updates).length) {
      messageBroker.publish("island_changes", updates)
    }
  })
}
