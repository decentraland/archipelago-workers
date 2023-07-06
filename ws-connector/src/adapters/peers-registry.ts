import { IBaseComponent } from '@well-known-components/interfaces'
import { InternalWebSocket } from '../types'

export type WsApp = {
  publish(topic: string, payload: Uint8Array, binary: boolean): void
}

export type IPeersRegistryComponent = IBaseComponent & {
  onPeerConnected(id: string, ws: InternalWebSocket): void
  onPeerDisconnected(id: string): void
  getPeerWs(id: string): InternalWebSocket | undefined
  getPeerCount(): number
}

export async function createPeersRegistry(): Promise<IPeersRegistryComponent> {
  const connectedPeers = new Map<string, InternalWebSocket>()

  function onPeerConnected(id: string, ws: InternalWebSocket): void {
    connectedPeers.set(id, ws)
  }

  function onPeerDisconnected(id: string): void {
    connectedPeers.delete(id)
  }

  function getPeerWs(id: string): InternalWebSocket | undefined {
    return connectedPeers.get(id)
  }

  function getPeerCount(): number {
    return connectedPeers.size
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    getPeerWs,
    getPeerCount
  }
}
