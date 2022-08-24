import { encodeJson } from '@well-known-components/nats-component'

import { BaseComponents, ChangeToIslandUpdate, PeerData, Island } from '../types'
import {
  IslandChangedMessage,
  JoinIslandMessage,
  LeftIslandMessage,
  IslandStatusMessage,
  IslandData
} from '../controllers/proto/archipelago'

import { IBaseComponent } from '@well-known-components/interfaces'

export type ServiceDiscoveryMessage = {
  serverName: string
  status: any
}

export type IPublisherComponent = IBaseComponent & {
  onChangeToIsland(peerId: string, island: Island, change: ChangeToIslandUpdate): void
  onPeerLeft(peerId: string, islandId: string): void
  publishServiceDiscoveryMessage(): void
  publishIslandsReport(islands: Island[]): void
}

export async function createPublisherComponent({
  nats,
  config
}: Pick<BaseComponents, 'config' | 'nats'>): Promise<IPublisherComponent> {
  const commitHash = await config.getString('COMMIT_HASH')

  function onChangeToIsland(peerId: string, toIsland: Island, update: ChangeToIslandUpdate) {
    const islandChangedMessage: IslandChangedMessage = {
      islandId: update.islandId,
      connStr: update.connStr,
      peers: {}
    }

    toIsland.peers.forEach((peerData: PeerData) => {
      islandChangedMessage.peers[peerData.id] = {
        x: peerData.position[0],
        y: peerData.position[1],
        z: peerData.position[2]
      }
    })
    if (update.fromIslandId) {
      islandChangedMessage.fromIslandId = update.fromIslandId
    }
    nats.publish(`client-proto.${peerId}.island_changed`, IslandChangedMessage.encode(islandChangedMessage).finish())

    nats.publish(
      `client-proto.island.${update.islandId}.peer_join`,
      JoinIslandMessage.encode({
        islandId: update.islandId,
        peerId
      }).finish()
    )
  }

  function onPeerLeft(peerId: string, islandId: string) {
    nats.publish(
      `client-proto.island.${islandId}.peer_left`,
      LeftIslandMessage.encode({
        islandId: islandId,
        peerId
      }).finish()
    )
  }

  function publishServiceDiscoveryMessage() {
    const status = {
      currentTime: Date.now(),
      commitHash
    }
    const serviceDiscoveryMessage: ServiceDiscoveryMessage = {
      serverName: 'archipelago',
      status
    }
    const encodedMsg = encodeJson(serviceDiscoveryMessage)
    nats.publish('service.discovery', encodedMsg)
  }

  function publishIslandsReport(islands: Island[]) {
    const data: IslandData[] = islands.map((i) => {
      return {
        id: i.id,
        center: {
          x: i.center[0],
          y: i.center[1],
          z: i.center[2]
        },
        maxPeers: i.maxPeers,
        radius: i.radius,
        peers: i.peers.map((p) => p.id)
      }
    })
    const message = IslandStatusMessage.encode({ data }).finish()
    nats.publish('archipelago.islands', message)
  }

  return {
    onChangeToIsland,
    onPeerLeft,
    publishServiceDiscoveryMessage,
    publishIslandsReport
  }
}
