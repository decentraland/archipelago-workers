import { IslandUpdates, PeerPositionChange, Position3D } from "../logic/archipelago"
import { GlobalContext } from "../types"
import {
  PeerConnectMessage,
  PeerDisconnectMessage,
  HeartbeatMessage,
  IslandChangedMessage,
  IslandLeftMessage,
} from "./proto/nats_pb"

const lastPeerHeartbeats = new Map<string, number>()

export async function setupTopics(globalContext: GlobalContext): Promise<void> {
  const { messageBroker, archipelago, config, logs } = globalContext.components

  const logger = logs.getLogger("Topics")

  // Clear peers that did not send heartbeats in the required interval
  const checkHeartbeatInterval = await config.requireNumber("CHECK_HEARTBEAT_INTERVAL")
  setInterval(() => {
    const expiredHeartbeat = Date.now() - checkHeartbeatInterval
    const hasExpired = ([_, lastHearbeat]: [string, number]) => lastHearbeat < expiredHeartbeat
    const getPeerId = ([peerId, _]: [string, number]) => peerId

    const inactivePeers = Array.from(lastPeerHeartbeats).filter(hasExpired).map(getPeerId)

    inactivePeers.forEach((peerId) => lastPeerHeartbeats.delete(peerId))
    archipelago.clearPeers(...inactivePeers)
  }, checkHeartbeatInterval)

  messageBroker.subscribe("peer.*.connect", (data: Uint8Array) => {
    try {
      const message = PeerConnectMessage.deserializeBinary(data)
      archipelago.clearPeers(message.getPeerId())
    } catch (e) {
      logger.error(`cannot process peer_connect message ${e}`)
    }
  })

  messageBroker.subscribe("peer.*.disconnect", (data: Uint8Array) => {
    try {
      const message = PeerDisconnectMessage.deserializeBinary(data)
      archipelago.clearPeers(message.getPeerId())
    } catch (e) {
      logger.error(`cannot process peer_disconnect message ${e}`)
    }
  })

  messageBroker.subscribe("peer.*.heartbeat", (data: Uint8Array) => {
    try {
      const message = HeartbeatMessage.deserializeBinary(data)

      const peerPositionChange: PeerPositionChange = {
        id: message.getId(),
        position: message.getPositionList() as Position3D,
      }

      lastPeerHeartbeats.set(peerPositionChange.id, Date.now())
      archipelago.setPeersPositions(peerPositionChange)
    } catch (e) {
      logger.error(`cannot process heartbeat message ${e}`)
    }
  })

  archipelago.subscribeToUpdates((updates: IslandUpdates) => {
    if (!Object.keys(updates).length) {
      return
    }

    Object.keys(updates).forEach((peerId) => {
      const update = updates[peerId]

      if (update.action === "changeTo") {
        const message = new IslandChangedMessage()
        message.setIslandId(update.islandId)
        message.setConnStr(update.connStr)
        if (update.fromIslandId) {
          message.setFromIslandId(update.fromIslandId)
        }
        messageBroker.publish(`peer.${peerId}.island_changed`, message.serializeBinary())
      } else if (update.action === "leave") {
        const message = new IslandLeftMessage()
        message.setIslandId(update.islandId)
        messageBroker.publish(`peer.${peerId}.island_left`, message.serializeBinary())
      }
    })
  })
}
