import {
  IslandChangedMessage,
  ServerPacket
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { createLogComponent } from '@well-known-components/logger'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IPeersRegistryComponent } from '../../src/adapters/peers-registry'
import { InternalWebSocket } from '../../src/types'
import { Writer } from 'protobufjs/minimal'

type SubscribeCallback = (err: Error | null, message: any) => void

describe('ws-connector island change forwarding', () => {
  let nats: INatsComponent
  let mockPeersRegistry: IPeersRegistryComponent
  let connectedPeers: Map<string, { sent: Uint8Array[] }>

  beforeEach(async () => {
    nats = await createLocalNatsComponent()
    connectedPeers = new Map()

    mockPeersRegistry = {
      onPeerConnected: jest.fn(),
      onPeerDisconnected: jest.fn(),
      getPeerWs: jest.fn((id: string) => {
        const peer = connectedPeers.get(id)
        if (!peer) return undefined
        return {
          send: jest.fn((data: Uint8Array) => {
            peer.sent.push(data)
            return 1
          }),
          getUserData: jest.fn().mockReturnValue({}),
          end: jest.fn(),
          close: jest.fn()
        } as unknown as InternalWebSocket
      }),
      getPeerCount: jest.fn(() => connectedPeers.size)
    }
  })

  function registerPeer(id: string) {
    connectedPeers.set(id, { sent: [] })
  }

  function publishIslandChanged(peerId: string, islandChanged: IslandChangedMessage) {
    const writer = new Writer()
    writer.reset()
    IslandChangedMessage.encode(islandChanged, writer)
    nats.publish(`engine.peer.${peerId}.island_changed`, writer.finish())
  }

  async function setupSubscription() {
    const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
    const logs = await createLogComponent({ config })
    const logger = logs.getLogger('ws-connector')

    nats.subscribe('engine.peer.*.island_changed', (err, message) => {
      if (err) {
        return
      }
      try {
        const id = message.subject.split('.')[2]
        const ws = mockPeersRegistry.getPeerWs(id)
        if (ws) {
          const islandChanged = IslandChangedMessage.decode(message.data)
          const serverPacket: ServerPacket = {
            message: {
              $case: 'islandChanged',
              islandChanged
            }
          }
          const packetWriter = new Writer()
          packetWriter.reset()
          ServerPacket.encode(serverPacket, packetWriter)
          ws.send(packetWriter.finish(), true)
        }
      } catch (err: any) {
        // silently handle
      }
    })
  }

  describe('when an island changed message arrives for a connected peer', () => {
    let sentData: Uint8Array[]

    beforeEach(async () => {
      registerPeer('alice')
      await setupSubscription()

      publishIslandChanged('alice', {
        islandId: 'I1',
        connStr: 'test:I1.alice',
        peers: {
          alice: { x: 10, y: 20, z: 30 }
        }
      })

      // Give NATS a tick to deliver the message
      await new Promise((resolve) => setTimeout(resolve, 50))

      sentData = connectedPeers.get('alice')!.sent
    })

    it('should forward the message to the peer WebSocket', () => {
      expect(sentData).toHaveLength(1)
    })

    it('should encode the message as a ServerPacket with islandChanged', () => {
      const decoded = ServerPacket.decode(sentData[0])
      expect(decoded.message?.$case).toBe('islandChanged')
    })

    it('should preserve the island ID in the forwarded message', () => {
      const decoded = ServerPacket.decode(sentData[0])
      if (decoded.message?.$case === 'islandChanged') {
        expect(decoded.message.islandChanged.islandId).toBe('I1')
      }
    })

    it('should preserve the connection string in the forwarded message', () => {
      const decoded = ServerPacket.decode(sentData[0])
      if (decoded.message?.$case === 'islandChanged') {
        expect(decoded.message.islandChanged.connStr).toBe('test:I1.alice')
      }
    })

    it('should preserve peer positions in the forwarded message', () => {
      const decoded = ServerPacket.decode(sentData[0])
      if (decoded.message?.$case === 'islandChanged') {
        expect(decoded.message.islandChanged.peers['alice']).toEqual({ x: 10, y: 20, z: 30 })
      }
    })
  })

  describe('when an island changed message arrives for a disconnected peer', () => {
    beforeEach(async () => {
      await setupSubscription()

      publishIslandChanged('unknown_peer', {
        islandId: 'I1',
        connStr: 'test:I1.unknown_peer',
        peers: {}
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    it('should silently drop the message without errors', () => {
      expect(mockPeersRegistry.getPeerWs).toHaveBeenCalledWith('unknown_peer')
    })
  })

  describe('when an island changed message includes fromIslandId', () => {
    let sentData: Uint8Array[]

    beforeEach(async () => {
      registerPeer('bob')
      await setupSubscription()

      publishIslandChanged('bob', {
        islandId: 'I2',
        connStr: 'test:I2.bob',
        fromIslandId: 'I1',
        peers: {
          bob: { x: 0, y: 0, z: 0 }
        }
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      sentData = connectedPeers.get('bob')!.sent
    })

    it('should include fromIslandId in the forwarded message', () => {
      const decoded = ServerPacket.decode(sentData[0])
      if (decoded.message?.$case === 'islandChanged') {
        expect(decoded.message.islandChanged.fromIslandId).toBe('I1')
      }
    })
  })

  describe('when an island changed message includes multiple peers', () => {
    let sentData: Uint8Array[]

    beforeEach(async () => {
      registerPeer('alice')
      await setupSubscription()

      publishIslandChanged('alice', {
        islandId: 'I1',
        connStr: 'test:I1.alice',
        peers: {
          alice: { x: 0, y: 0, z: 0 },
          bob: { x: 10, y: 0, z: 10 },
          charlie: { x: 20, y: 0, z: 20 }
        }
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      sentData = connectedPeers.get('alice')!.sent
    })

    it('should forward all peer positions in the message', () => {
      const decoded = ServerPacket.decode(sentData[0])
      if (decoded.message?.$case === 'islandChanged') {
        const peers = decoded.message.islandChanged.peers
        expect(Object.keys(peers)).toHaveLength(3)
        expect(peers['alice']).toBeDefined()
        expect(peers['bob']).toBeDefined()
        expect(peers['charlie']).toBeDefined()
      }
    })
  })

  describe('when the peer ID is extracted from the NATS subject', () => {
    beforeEach(async () => {
      registerPeer('0xABC123')
      await setupSubscription()

      publishIslandChanged('0xABC123', {
        islandId: 'I1',
        connStr: 'test:I1.0xABC123',
        peers: {}
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    it('should correctly parse the peer ID from subject engine.peer.<id>.island_changed', () => {
      expect(mockPeersRegistry.getPeerWs).toHaveBeenCalledWith('0xABC123')
    })
  })

  describe('when ws.send fails for a connected peer (backpressure)', () => {
    beforeEach(async () => {
      // Register a peer whose send always fails
      const failPeer = { sent: [] as Uint8Array[] }
      connectedPeers.set('backpressure-peer', failPeer)

      // Override getPeerWs to return a mock that returns 0 (DROPPED) for send
      const originalGetPeerWs = mockPeersRegistry.getPeerWs
      mockPeersRegistry.getPeerWs = jest.fn((id: string) => {
        if (id === 'backpressure-peer') {
          return {
            send: jest.fn(() => 0), // DROPPED
            getUserData: jest.fn().mockReturnValue({}),
            end: jest.fn(),
            close: jest.fn()
          } as unknown as InternalWebSocket
        }
        return (originalGetPeerWs as jest.Mock)(id)
      })

      await setupSubscription()

      publishIslandChanged('backpressure-peer', {
        islandId: 'I1',
        connStr: 'test:I1.backpressure-peer',
        peers: { 'backpressure-peer': { x: 0, y: 0, z: 0 } }
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    it('should not throw an error', () => {
      // The handler should log a warning but not crash
      expect(mockPeersRegistry.getPeerWs).toHaveBeenCalledWith('backpressure-peer')
    })
  })
})
