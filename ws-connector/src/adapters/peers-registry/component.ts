import { InternalWebSocket } from '../../types'
import { IPeersRegistryComponent, RegisteredPeer } from './types'

/**
 * Creates the in-memory registry of peers connected to this replica, keyed by wallet and then by
 * session key.
 *
 * Every ws-connector replica receives every `island_changed` event, and this registry is the
 * filter: only the replica holding the (wallet, session) the event is addressed to forwards it.
 * Keys are exact strings, so callers must register and look up with the same (lower-cased) forms.
 *
 * @returns The peers registry component.
 */
export async function createPeersRegistry(): Promise<IPeersRegistryComponent> {
  const connectedPeers = new Map<string, Map<string, InternalWebSocket>>()

  function onPeerConnected(id: string, session: string, ws: InternalWebSocket): void {
    let sessions = connectedPeers.get(id)
    if (!sessions) {
      sessions = new Map()
      connectedPeers.set(id, sessions)
    }
    // Delete before set so a replaced session moves to the end: a Map iterates in insertion
    // order, and getNewestPeerWs reads the last entry.
    sessions.delete(session)
    sessions.set(session, ws)
  }

  function onPeerDisconnected(id: string, session: string, ws: InternalWebSocket): void {
    // Only remove the entry if it still points to this socket. After a same-session reconnect
    // the previous socket closes later; without this guard its close would evict the new live
    // socket from the registry, hiding it from the island feed and the ban sweep.
    const sessions = connectedPeers.get(id)
    if (!sessions || sessions.get(session) !== ws) {
      return
    }
    sessions.delete(session)
    if (sessions.size === 0) {
      connectedPeers.delete(id)
    }
  }

  function getPeerWs(id: string, session: string): InternalWebSocket | undefined {
    return connectedPeers.get(id)?.get(session)
  }

  function getNewestPeerWs(id: string): InternalWebSocket | undefined {
    const sessions = connectedPeers.get(id)
    if (!sessions) {
      return undefined
    }
    let newest: InternalWebSocket | undefined
    for (const ws of sessions.values()) {
      newest = ws
    }
    return newest
  }

  function hasPeer(id: string): boolean {
    return connectedPeers.has(id)
  }

  function getPeerCount(): number {
    let count = 0
    for (const sessions of connectedPeers.values()) {
      count += sessions.size
    }
    return count
  }

  function snapshot(): RegisteredPeer[] {
    const peers: RegisteredPeer[] = []
    for (const [id, sessions] of connectedPeers) {
      for (const [session, ws] of sessions) {
        peers.push({ id, session, ws })
      }
    }
    return peers
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    getPeerWs,
    getNewestPeerWs,
    hasPeer,
    getPeerCount,
    snapshot
  }
}
