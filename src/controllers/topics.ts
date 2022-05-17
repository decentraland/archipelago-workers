import { IslandUpdates, PeerData, PeerPositionChange, Position3D } from "../logic/archipelago"
import { GlobalContext } from "../types"
import { HeartbeatMessage, IslandChangedMessage, LeftIslandMessage, JoinIslandMessage, Position3DMessage } from "./proto/archipelago_pb"

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

  messageBroker.subscribe("peer.*.connect", ({ topic }) => {
    try {
      const id = topic.getLevel(1)
      archipelago.clearPeers(id)
    } catch (e) {
      logger.error(`cannot process peer_connect message ${e}`)
    }
  })

  messageBroker.subscribe("peer.*.disconnect", ({ topic }) => {
    try {
      const id = topic.getLevel(1)
      archipelago.clearPeers(id)
    } catch (e) {
      logger.error(`cannot process peer_disconnect message ${e}`)
    }
  })

  messageBroker.subscribe("peer.*.heartbeat", ({ data, topic }) => {
    try {
      const id = topic.getLevel(1)
      const message = HeartbeatMessage.deserializeBinary(data)
      const position = message.getPosition()!

      const peerPositionChange: PeerPositionChange = {
        id,
        position: [position.getX(), position.getY(), position.getZ()]
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

    Object.keys(updates).forEach(async (peerId) => {
      const update = updates[peerId]

      if (update.action === "changeTo") {
        const island = await archipelago.getIsland(update.islandId)
        if (!island) {
          return
        }

        const islandChangedMessage = new IslandChangedMessage()
        islandChangedMessage.setIslandId(update.islandId)
        islandChangedMessage.setConnStr(update.connStr)


        const peers = islandChangedMessage.getPeersMap()
        island.peers.forEach((peerData: PeerData) => {
          const p = new Position3DMessage()
          p.setX(peerData.position[0])
          p.setY(peerData.position[1])
          p.setZ(peerData.position[2])
          peers.set(peerData.id, p)

        })
        if (update.fromIslandId) {
          islandChangedMessage.setFromIslandId(update.fromIslandId)
        }
        messageBroker.publish(`peer.${peerId}.island_changed`, islandChangedMessage.serializeBinary())


        const peerJoinMessage = new JoinIslandMessage()
        peerJoinMessage.setIslandId(update.islandId)
        peerJoinMessage.setPeerId(peerId)
        messageBroker.publish(`island.${update.islandId}.peer_join`, peerJoinMessage.serializeBinary())
      } else if (update.action === "leave") {
        const message = new LeftIslandMessage()
        message.setIslandId(update.islandId)
        message.setPeerId(peerId)
        const data = message.serializeBinary()
        messageBroker.publish(`island.${update.islandId}.peer_left`, data)
      }
    })
  })
}
