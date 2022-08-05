import {
  Island,
  IslandUpdates,
  PeerPositionChange,
  ArchipelagoMetrics,
  PeerData,
  UpdatableArchipelagoParameters
} from '../types'

export interface IArchipelago {
  getIslandsCount(): number
  getPeersCount(): number
  getPeerIds(): string[]
  clearPeers(ids: string[]): IslandUpdates
  getIsland(id: string): Island | undefined
  getIslands(): Island[]
  getPeerData(id: string): PeerData | undefined
  setPeersPositions(requests: PeerPositionChange[]): IslandUpdates
  modifyOptions(options: UpdatableArchipelagoParameters): IslandUpdates
  calculateMetrics(): ArchipelagoMetrics
}
