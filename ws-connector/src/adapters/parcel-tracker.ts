import { IBaseComponent } from '@well-known-components/interfaces'

export type IParcelTrackerComponent = IBaseComponent & {
  updatePeerPosition(peerId: string, x: number, z: number): void
  removePeer(peerId: string): void
  getPeersOnParcels(parcelStrs: string[]): string[]
}

export function createParcelTracker(): IParcelTrackerComponent {
  const peerToParcel = new Map<string, string>()
  const parcelToPeers = new Map<string, Set<string>>()

  function positionToParcel(x: number, z: number): string {
    return `${Math.floor(x / 16)},${Math.floor(z / 16)}`
  }

  function updatePeerPosition(peerId: string, x: number, z: number): void {
    const newParcel = positionToParcel(x, z)
    const currentParcel = peerToParcel.get(peerId)

    if (currentParcel === newParcel) {
      return
    }

    if (currentParcel) {
      const peers = parcelToPeers.get(currentParcel)
      if (peers) {
        peers.delete(peerId)
        if (peers.size === 0) {
          parcelToPeers.delete(currentParcel)
        }
      }
    }

    peerToParcel.set(peerId, newParcel)

    let peers = parcelToPeers.get(newParcel)
    if (!peers) {
      peers = new Set()
      parcelToPeers.set(newParcel, peers)
    }
    peers.add(peerId)
  }

  function removePeer(peerId: string): void {
    const parcel = peerToParcel.get(peerId)
    if (parcel) {
      const peers = parcelToPeers.get(parcel)
      if (peers) {
        peers.delete(peerId)
        if (peers.size === 0) {
          parcelToPeers.delete(parcel)
        }
      }
    }
    peerToParcel.delete(peerId)
  }

  function getPeersOnParcels(parcelStrs: string[]): string[] {
    const result = new Set<string>()
    for (const parcel of parcelStrs) {
      const peers = parcelToPeers.get(parcel)
      if (peers) {
        for (const peer of peers) {
          result.add(peer)
        }
      }
    }
    return Array.from(result)
  }

  return {
    updatePeerPosition,
    removePeer,
    getPeersOnParcels
  }
}
