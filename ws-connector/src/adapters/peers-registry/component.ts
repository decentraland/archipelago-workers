import { InternalWebSocket } from '../../types'
import { IPeersRegistryComponent } from './types'

/**
 * Creates the in-memory registry of peers connected to this replica.
 *
 * Every ws-connector replica receives every `island_changed` event, and this registry is the
 * filter: only the replica actually holding a peer's socket forwards to it. Keys are exact
 * strings, so callers must register and look up with the same (lower-cased) address form.
 *
 * @returns The peers registry component.
 */
export async function createPeersRegistry(): Promise<IPeersRegistryComponent> {
  const connectedPeers = new Map<string, InternalWebSocket>()

  function onPeerConnected(id: string, ws: InternalWebSocket): void {
    connectedPeers.set(id, ws)
  }

  function onPeerDisconnected(id: string, ws: InternalWebSocket): void {
    // Only remove the entry if it still points to this socket. After a reconnect
    // the previous socket closes later; without this guard its close would evict
    // the new live socket from the registry, hiding it from the ban sweep.
    if (connectedPeers.get(id) === ws) {
      connectedPeers.delete(id)
    }
  }

  function getPeerWs(id: string): InternalWebSocket | undefined {
    return connectedPeers.get(id)
  }

  function getPeerCount(): number {
    return connectedPeers.size
  }

  function snapshot(): { id: string; ws: InternalWebSocket }[] {
    return Array.from(connectedPeers, ([id, ws]) => ({ id, ws }))
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    getPeerWs,
    getPeerCount,
    snapshot
  }
}
