import { Reader } from 'protobufjs/minimal'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLocalNatsComponent, decodeJson } from '@well-known-components/nats-component'
import {
  IslandChangedMessage,
  IslandStatusMessage,
  JoinIslandMessage,
  LeftIslandMessage
} from '../../src/controllers/proto/archipelago'
import { createPublisherComponent, ServiceDiscoveryMessage } from '../../src/ports/publisher'
import { Island } from '../../src/types'

describe('publishing', () => {
  const commitHash = '1234456'
  const config = createConfigComponent({
    COMMIT_HASH: commitHash
  })

  it('should publish island changed messages', async () => {
    const nats = await createLocalNatsComponent()

    const island: Island = {
      id: 'i1',
      maxPeers: 100,
      center: [0, 0, 0],
      radius: 100,
      sequenceId: 0,
      peers: [
        { id: 'peer2', position: [0, 0, 0] },
        { id: 'peer3', position: [0, 0, 0] }
      ],
      transportId: 0,
      _geometryDirty: false
    }

    const { onChangeToIsland } = await createPublisherComponent({ nats, config })

    const peerSubscription = nats.subscribe('client-proto.peer1.island_changed')
    const islandSubscription = nats.subscribe('client-proto.island.i1.peer_join')

    onChangeToIsland('peer1', island, {
      action: 'changeTo',
      islandId: island.id,
      connStr: 'test'
    })

    for await (const message of peerSubscription.generator) {
      const m = IslandChangedMessage.decode(message.data)
      expect(m).toEqual(
        expect.objectContaining({
          fromIslandId: undefined,
          islandId: island.id,
          connStr: 'test',
          peers: {
            peer2: { x: 0, y: 0, z: 0 },
            peer3: { x: 0, y: 0, z: 0 }
          }
        })
      )
      break
    }
    for await (const message of islandSubscription.generator) {
      const m = JoinIslandMessage.decode(message.data)
      expect(m.islandId).toEqual(island.id)
      expect(m.peerId).toEqual('peer1')
      break
    }
  })

  it('should publish island island left', async () => {
    const nats = await createLocalNatsComponent()

    const { onPeerLeft } = await createPublisherComponent({ nats, config })

    const islandSubscription = nats.subscribe('client-proto.island.i1.peer_left')

    onPeerLeft('peer1', 'i1')

    for await (const message of islandSubscription.generator) {
      const m = LeftIslandMessage.decode(message.data)
      expect(m).toEqual(
        expect.objectContaining({
          islandId: 'i1',
          peerId: 'peer1'
        })
      )
      break
    }
  })

  it('should publish to service discovery', async () => {
    const now = Date.now()
    Date.now = jest.fn(() => now)

    const nats = await createLocalNatsComponent()

    const s = nats.subscribe('service.discovery')

    const { publishServiceDiscoveryMessage } = await createPublisherComponent({ nats, config })

    publishServiceDiscoveryMessage()

    for await (const message of s.generator) {
      const data: ServiceDiscoveryMessage = decodeJson(message.data) as any
      expect(data).toEqual(
        expect.objectContaining({
          serverName: 'archipelago',
          status: {
            currentTime: now,
            commitHash
          }
        })
      )
      break
    }
  })

  it('should publish island status ', async () => {
    const nats = await createLocalNatsComponent()
    const islands: Island[] = [
      {
        id: 'I1',
        center: [0, 0, 0],
        radius: 100,
        maxPeers: 100,
        peers: [],
        sequenceId: 10,
        transportId: 0,
        _geometryDirty: false
      }
    ]

    const s = nats.subscribe('archipelago.islands')

    const { publishIslandsReport } = await createPublisherComponent({ nats, config })
    publishIslandsReport(islands)

    for await (const message of s.generator) {
      const { data } = IslandStatusMessage.decode(Reader.create(message.data))
      expect(data).toHaveLength(1)
      expect(data).toEqual(
        expect.arrayContaining([
          {
            id: 'I1',
            peers: [],
            maxPeers: 100,
            center: {
              x: 0,
              y: 0,
              z: 0
            },
            radius: 100
          }
        ])
      )
      break
    }
  })
})
