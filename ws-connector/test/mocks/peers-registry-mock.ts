import { IPeersRegistryComponent } from '../../src/adapters/peers-registry'
import { InternalWebSocket } from '../../src/types'

export const createPeersRegistryMockedComponent = (
  overrides?: Partial<jest.Mocked<IPeersRegistryComponent>>
): jest.Mocked<IPeersRegistryComponent> => {
  // Backed by a real Map so read-your-writes works without every test wiring it up, while
  // still allowing any method to be overridden to assert on the interaction.
  const peers = new Map<string, InternalWebSocket>()

  return {
    onPeerConnected: jest.fn((id: string, ws: InternalWebSocket) => {
      peers.set(id, ws)
    }),
    onPeerDisconnected: jest.fn((id: string, ws: InternalWebSocket) => {
      if (peers.get(id) === ws) {
        peers.delete(id)
      }
    }),
    getPeerWs: jest.fn((id: string) => peers.get(id)),
    getPeerCount: jest.fn(() => peers.size),
    snapshot: jest.fn(() => Array.from(peers, ([id, ws]) => ({ id, ws }))),
    ...overrides
  } as unknown as jest.Mocked<IPeersRegistryComponent>
}
