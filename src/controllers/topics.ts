import { IslandUpdates, PeerData, PeerPositionChange } from '../logic/archipelago'
import { GlobalContext } from '../types'
import { HeartbeatMessage, IslandChangedMessage, LeftIslandMessage, JoinIslandMessage } from './proto/archipelago'
import { Reader } from 'protobufjs/minimal'

const lastPeerHeartbeats = new Map<string, number>()

export async function setupTopics(globalContext: GlobalContext): Promise<void> {
  const { messageBroker, archipelago, config, logs } = globalContext.components

  const logger = logs.getLogger('Topics')

  // Clear peers that did not send heartbeats in the required interval
  const checkHeartbeatInterval = await config.requireNumber('CHECK_HEARTBEAT_INTERVAL')
  setInterval(() => {
    const expiredHeartbeat = Date.now() - checkHeartbeatInterval
    const hasExpired = ([_, lastHearbeat]: [string, number]) => lastHearbeat < expiredHeartbeat
    const getPeerId = ([peerId, _]: [string, number]) => peerId

    const inactivePeers = Array.from(lastPeerHeartbeats).filter(hasExpired).map(getPeerId)

    inactivePeers.forEach((peerId) => lastPeerHeartbeats.delete(peerId))
    archipelago.clearPeers(...inactivePeers)
  }, checkHeartbeatInterval)

  messageBroker.subscribe('peer.*.connect', ({ topic }) => {
    try {
      const id = topic.getLevel(1)
      archipelago.clearPeers(id)
    } catch (e) {
      logger.error(`cannot process peer_connect message ${e}`)
    }
  })

  messageBroker.subscribe('peer.*.disconnect', ({ topic }) => {
    try {
      const id = topic.getLevel(1)
      archipelago.clearPeers(id)
    } catch (e) {
      logger.error(`cannot process peer_disconnect message ${e}`)
    }
  })

  messageBroker.subscribe('client-proto.peer.*.heartbeat', ({ data, topic }) => {
    try {
      const id = topic.getLevel(2)
      const message = HeartbeatMessage.decode(Reader.create(data))
      const position = message.position!

      const peerPositionChange: PeerPositionChange = {
        id,
        position: [position.x, position.y, position.z]
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

      if (update.action === 'changeTo') {
        const island = await archipelago.getIsland(update.islandId)
        if (!island) {
          return
        }

        const islandChangedMessage: IslandChangedMessage = {
          islandId: update.islandId,
          connStr: update.connStr,
          peers: {}
        }

        island.peers.forEach((peerData: PeerData) => {
          islandChangedMessage.peers[peerData.id] = {
            x: peerData.position[0],
            y: peerData.position[1],
            z: peerData.position[2]
          }
        })
        if (update.fromIslandId) {
          islandChangedMessage.fromIslandId = update.fromIslandId
        }
        messageBroker.publish(
          `client-proto.${peerId}.island_changed`,
          IslandChangedMessage.encode(islandChangedMessage).finish()
        )

        messageBroker.publish(
          `client-proto.island.${update.islandId}.peer_join`,
          JoinIslandMessage.encode({
            islandId: update.islandId,
            peerId
          }).finish()
        )
      } else if (update.action === 'leave') {
        messageBroker.publish(
          `client-proto.island.${update.islandId}.peer_left`,
          LeftIslandMessage.encode({
            islandId: update.islandId,
            peerId
          }).finish()
        )
      }
    })
  })
}
