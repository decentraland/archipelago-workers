import { IPeersRegistryComponent, RegisteredPeer } from '../../src/adapters/peers-registry'
import { InternalWebSocket } from '../../src/types'

export const createPeersRegistryMockedComponent = (
  overrides?: Partial<jest.Mocked<IPeersRegistryComponent>>
): jest.Mocked<IPeersRegistryComponent> => {
  // Backed by real Maps so read-your-writes works without every test wiring it up, while
  // still allowing any method to be overridden to assert on the interaction.
  const peers = new Map<string, Map<string, InternalWebSocket>>()

  function sessionsOf(id: string): Map<string, InternalWebSocket> {
    let sessions = peers.get(id)
    if (!sessions) {
      sessions = new Map()
      peers.set(id, sessions)
    }
    return sessions
  }

  return {
    onPeerConnected: jest.fn((id: string, session: string, ws: InternalWebSocket) => {
      const sessions = sessionsOf(id)
      sessions.delete(session)
      sessions.set(session, ws)
    }),
    onPeerDisconnected: jest.fn((id: string, session: string, ws: InternalWebSocket) => {
      const sessions = peers.get(id)
      if (sessions?.get(session) === ws) {
        sessions.delete(session)
        if (sessions.size === 0) peers.delete(id)
      }
    }),
    getPeerWs: jest.fn((id: string, session: string) => peers.get(id)?.get(session)),
    getNewestPeerWs: jest.fn((id: string) => {
      let newest: InternalWebSocket | undefined
      for (const ws of peers.get(id)?.values() ?? []) newest = ws
      return newest
    }),
    hasPeer: jest.fn((id: string) => peers.has(id)),
    getPeerCount: jest.fn(() => Array.from(peers.values()).reduce((count, sessions) => count + sessions.size, 0)),
    snapshot: jest.fn((): RegisteredPeer[] =>
      Array.from(peers, ([id, sessions]) => Array.from(sessions, ([session, ws]) => ({ id, session, ws }))).flat()
    ),
    ...overrides
  } as unknown as jest.Mocked<IPeersRegistryComponent>
}
