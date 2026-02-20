import { IBaseComponent } from '@well-known-components/interfaces'

export type IIslandRegistryComponent = IBaseComponent & {
  setPeerIsland(peerId: string, islandId: string): void
  removePeer(peerId: string): void
  getPeersOnIsland(islandId: string): string[]
  getPeerIsland(peerId: string): string | undefined
}

export function createIslandRegistry(): IIslandRegistryComponent {
  const peerToIsland = new Map<string, string>()
  const islandToPeers = new Map<string, Set<string>>()

  function setPeerIsland(peerId: string, islandId: string): void {
    const previousIsland = peerToIsland.get(peerId)
    if (previousIsland) {
      const peers = islandToPeers.get(previousIsland)
      if (peers) {
        peers.delete(peerId)
        if (peers.size === 0) {
          islandToPeers.delete(previousIsland)
        }
      }
    }

    peerToIsland.set(peerId, islandId)

    let peers = islandToPeers.get(islandId)
    if (!peers) {
      peers = new Set()
      islandToPeers.set(islandId, peers)
    }
    peers.add(peerId)
  }

  function removePeer(peerId: string): void {
    const islandId = peerToIsland.get(peerId)
    if (islandId) {
      const peers = islandToPeers.get(islandId)
      if (peers) {
        peers.delete(peerId)
        if (peers.size === 0) {
          islandToPeers.delete(islandId)
        }
      }
    }
    peerToIsland.delete(peerId)
  }

  function getPeersOnIsland(islandId: string): string[] {
    const peers = islandToPeers.get(islandId)
    return peers ? Array.from(peers) : []
  }

  function getPeerIsland(peerId: string): string | undefined {
    return peerToIsland.get(peerId)
  }

  return {
    setPeerIsland,
    removePeer,
    getPeersOnIsland,
    getPeerIsland
  }
}
