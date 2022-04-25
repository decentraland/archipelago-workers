import { IslandUpdates, PeerPositionChange } from "../logic/archipelago"
import { JSONCodec, StringCodec } from "nats"
import { GlobalContext } from "../types"

const lastPeerHeartbeats = new Map<string, number>()

const jsonCodec = JSONCodec()
const stringCodec = StringCodec()

export async function setupTopics(globalContext: GlobalContext): Promise<void> {
  const { messageBroker, archipelago, config } = globalContext.components

  // Clear peers that did not send heartbeats in the required interval
  const checkHeartbeatInterval = await config.requireNumber("CHECK_HEARTBEAT_INTERVAL")
  setInterval(() => {
    const expiredHeartbeat = Date.now() - checkHeartbeatInterval
    const hasExpired = ([_, lastHearbeat]: [string, number]) => lastHearbeat < expiredHeartbeat
    const getPeerId = ([peerId, _]: [string, number]) => peerId

    const inactivePeers = Array.from(lastPeerHeartbeats).filter(hasExpired).map(getPeerId)
    console.log(lastPeerHeartbeats, inactivePeers)

    inactivePeers.forEach((peerId) => lastPeerHeartbeats.delete(peerId))
    archipelago.clearPeers(...inactivePeers)
  }, checkHeartbeatInterval)

  messageBroker.subscribe("peer_connect", (data: Uint8Array) => {
    const peerId = stringCodec.decode(data)
    archipelago.clearPeers(peerId)
  })

  messageBroker.subscribe("peer_disconnect", (data: Uint8Array) => {
    const peerId = stringCodec.decode(data)
    lastPeerHeartbeats.delete(peerId)
    archipelago.clearPeers(peerId)
  })

  messageBroker.subscribe("heartbeat", (data: Uint8Array) => {
    const peerPositionChange = jsonCodec.decode(data) as PeerPositionChange
    lastPeerHeartbeats.set(peerPositionChange.id, Date.now())
    archipelago.setPeersPositions(peerPositionChange)
  })

  archipelago.subscribeToUpdates((updates: IslandUpdates) => {
    if (Object.keys(updates).length) {
      messageBroker.publish("island_changes", updates)
    }
  })
}
