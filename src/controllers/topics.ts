import { IslandUpdates, PeerData, PeerPositionChange, Position3D } from '../logic/archipelago'
import { GlobalContext, Parcel, ServiceDiscoveryMessage } from '../types'
import { HeartbeatMessage, IslandChangedMessage, LeftIslandMessage, JoinIslandMessage } from './proto/archipelago'
import { Reader } from 'protobufjs/minimal'
import { JSONCodec } from 'nats'

export async function setupTopics(globalContext: GlobalContext): Promise<void> {
  const { messageBroker, archipelago, config, logs, metrics, realm } = globalContext.components

  const PARCEL_SIZE = await config.requireNumber('ARCHIPELAGO_PARCEL_SIZE')
  const jsonCodec = JSONCodec()
  const lastPeerHeartbeats = new Map<string, number>()
  const logger = logs.getLogger('Topics')

  // Clear peers that did not send heartbeats in the required interval
  const checkHeartbeatInterval = await config.requireNumber('CHECK_HEARTBEAT_INTERVAL')
  const archipelagoMetricsInterval = await config.requireNumber('ARCHIPELAGO_METRICS_INTERVAL')

  setInterval(() => {
    const expiredHeartbeatTime = Date.now() - checkHeartbeatInterval

    const inactivePeers = Array.from(lastPeerHeartbeats)
      .filter(([_, lastHearbeat]) => lastHearbeat < expiredHeartbeatTime)
      .map(([peerId, _]) => peerId)

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

  archipelago.subscribeToUpdates(async (updates: IslandUpdates) => {
    // Prevent processing updates if there are no changes
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

  // Metrics
  setInterval(async () => {
    try {
      const archMetrics = await archipelago.calculateMetrics()
      // logger.info(`Archipelago Metrics: ${JSON.stringify(archMetrics)}`)

      metrics.observe('dcl_archipelago_peers_count', { transport: 'livekit' }, archMetrics.peers.transport.livekit)
      metrics.observe('dcl_archipelago_peers_count', { transport: 'ws' }, archMetrics.peers.transport.ws)
      metrics.observe('dcl_archipelago_peers_count', { transport: 'p2p' }, archMetrics.peers.transport.p2p)

      metrics.observe('dcl_archipelago_islands_count', { transport: 'livekit' }, archMetrics.islands.transport.livekit)
      metrics.observe('dcl_archipelago_islands_count', { transport: 'ws' }, archMetrics.islands.transport.ws)
      metrics.observe('dcl_archipelago_islands_count', { transport: 'p2p' }, archMetrics.islands.transport.p2p)
    } catch (err: any) {
      logger.error(err)
    }
  }, archipelagoMetricsInterval)

  // Status
  const worldToGrid = (position: Position3D): Parcel => {
    const parcelX = Math.floor(position[0] / PARCEL_SIZE)
    const parcelY = Math.floor(position[2] / PARCEL_SIZE)
    return [parcelX, parcelY]
  }
  const getStatus = async () => {
    const islands = await archipelago.getIslands()
    const usersPositions = islands.map((island) => island.peers.map((peer) => peer.position)).flat()
    const usersParcels = usersPositions.map((position) => worldToGrid(position))

    const [maxUsers, commitHash, catalystVersion] = await Promise.all([
      config.getNumber('MAX_CONCURRENT_USERS'),
      config.getString('COMMIT_HASH'),
      config.getString('CATALYST_VERSION')
    ])

    const status = {
      name: realm.getRealmName(),
      version: '1.0.0',
      currenTime: Date.now(),
      env: {
        secure: false,
        commitHash,
        catalystVersion: catalystVersion || 'Unknown'
      },
      ready: true,
      usersCount: usersPositions.length,
      islandsCount: islands.length,
      maxUsers: maxUsers ?? 5000,
      usersParcels
    }

    return status
  }
  setInterval(async () => {
    try {
      const status = await getStatus()
      const serviceDiscoveryMessage: ServiceDiscoveryMessage = {
        serverName: 'archipelago',
        status
      }
      const encodedMsg = jsonCodec.encode(serviceDiscoveryMessage)
      messageBroker.publish('service.discovery', encodedMsg)
    } catch (err: any) {
      logger.error(err)
    }
  }, await config.requireNumber('ARCHIPELAGO_STATUS_UPDATE_INTERVAL'))
}
