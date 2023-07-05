import { IBaseComponent } from '@well-known-components/interfaces'
import { PeerData, IslandData } from '../types'

export type IStatsComponent = IBaseComponent & {
  onPeerDisconnected(peerId: string): void
  onPeerUpdated(peerId: string, data: PeerData): void
  onIslandsDataReceived(data: IslandData[]): void

  getPeers(): Map<string, PeerData>
  getIslands(): IslandData[]
}

export function createStatsComponent(): IStatsComponent {
  const peers = new Map<string, PeerData>()
  let islands: IslandData[] = []

  function onPeerDisconnected(peerId: string) {
    peers.delete(peerId)
  }

  function onPeerUpdated(peerId: string, data: PeerData) {
    peers.set(peerId, data)
  }

  function onIslandsDataReceived(data: IslandData[]) {
    islands = data
  }

  return {
    onPeerDisconnected,
    onPeerUpdated,
    onIslandsDataReceived,
    getPeers: () => peers,
    getIslands: () => islands
  }
}
