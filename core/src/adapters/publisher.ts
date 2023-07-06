import { encodeJson } from '@well-known-components/nats-component'
import { BaseComponents, ChangeToIslandUpdate, Island, PeerData } from '../types'
import {
  IslandStatusMessage,
  IslandData,
  IslandChangedMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'

import { IBaseComponent } from '@well-known-components/interfaces'

export type ServiceDiscoveryMessage = {
  serverName: string
  status: {
    currentTime: number
    commitHash?: string
    userCount: number
  }
}

export type IPublisherComponent = IBaseComponent & {
  onChangeToIsland(peerId: string, island: Island, change: ChangeToIslandUpdate): void
  publishServiceDiscoveryMessage(userCount: number): void
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
    nats.publish(`engine.peer.${peerId}.island_changed`, IslandChangedMessage.encode(islandChangedMessage).finish())
  }

  function publishServiceDiscoveryMessage(userCount: number) {
    const serviceDiscoveryMessage: ServiceDiscoveryMessage = {
      serverName: 'archipelago',
      status: {
        currentTime: Date.now(),
        commitHash,
        userCount
      }
    }
    nats.publish('engine.discovery', encodeJson(serviceDiscoveryMessage))
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
    nats.publish('engine.islands', IslandStatusMessage.encode({ data }).finish())
  }

  return {
    onChangeToIsland,
    publishServiceDiscoveryMessage,
    publishIslandsReport
  }
}
