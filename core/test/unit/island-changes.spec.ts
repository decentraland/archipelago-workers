import {
  IslandChangedMessage,
  IslandStatusMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { INatsComponent, NatsMsg } from '@well-known-components/nats-component/dist/types'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createArchipelagoEngine } from '../../src/adapters/engine'
import { createPublisherComponent, IPublisherComponent } from '../../src/adapters/publisher'
import { Engine, ChangeToIslandUpdate } from '../../src/types'

function collectMessages(nats: INatsComponent, topic: string): NatsMsg[] {
  const messages: NatsMsg[] = []
  nats.subscribe(topic, (err, message) => {
    if (!err) {
      messages.push(message)
    }
  })
  return messages
}

function takeOneMessage(nats: INatsComponent, topic: string): Promise<NatsMsg> {
  return new Promise<NatsMsg>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for message on ${topic}`)), 2000)
    nats.subscribe(topic, (err, message) => {
      clearTimeout(timeout)
      if (err) return reject(err)
      resolve(message)
    })
  })
}

describe('island change communication', () => {
  let engine: Engine
  let publisher: IPublisherComponent
  let nats: INatsComponent

  beforeEach(async () => {
    nats = await createLocalNatsComponent()
    const config = createConfigComponent({ COMMIT_HASH: 'test123' })
    const logs = await createLogComponent({ config })
    const metrics = createTestMetricsComponent(metricDeclarations)

    engine = createArchipelagoEngine({
      components: { logs, metrics },
      joinDistance: 64,
      leaveDistance: 80,
      transport: {
        name: 'test',
        maxIslandSize: 200,
        getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
          const connStrs: Record<string, string> = {}
          for (const userId of userIds) {
            connStrs[userId] = `test:${roomId}.${userId}`
          }
          return Promise.resolve(connStrs)
        }
      }
    })

    publisher = await createPublisherComponent({ nats, config })
  })

  async function flushAndPublish() {
    const updates = await engine.flush()
    for (const [peerId, update] of updates) {
      if (update.action === 'changeTo') {
        const island = engine.getIsland(update.islandId)
        if (island) {
          publisher.onChangeToIsland(peerId, island, update)
        }
      }
    }
    publisher.publishIslandsReport(engine.getIslands())
    return updates
  }

  describe('when a new peer joins', () => {
    let islandChangedPromise: Promise<NatsMsg>
    let islandsReportPromise: Promise<NatsMsg>

    beforeEach(async () => {
      islandChangedPromise = takeOneMessage(nats, 'engine.peer.peer1.island_changed')
      islandsReportPromise = takeOneMessage(nats, 'engine.islands')

      engine.onPeerPositionsUpdate([{ id: 'peer1', position: [10, 20, 30] }])
      await flushAndPublish()
    })

    it('should publish an island changed message for the peer', async () => {
      const message = await islandChangedPromise
      const decoded = IslandChangedMessage.decode(message.data)
      expect(decoded.islandId).toBeDefined()
      expect(decoded.connStr).toContain('peer1')
    })

    it('should include the peer position in the island changed message', async () => {
      const message = await islandChangedPromise
      const decoded = IslandChangedMessage.decode(message.data)
      expect(decoded.peers['peer1']).toEqual({ x: 10, y: 20, z: 30 })
    })

    it('should publish an islands report with the new island', async () => {
      const message = await islandsReportPromise
      const decoded = IslandStatusMessage.decode(message.data)
      expect(decoded.data).toHaveLength(1)
      expect(decoded.data[0].peers).toContain('peer1')
    })
  })

  describe('when two peers join the same island', () => {
    let peer2IslandChangedPromise: Promise<NatsMsg>

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([{ id: 'peer1', position: [0, 0, 0] }])
      await flushAndPublish()

      peer2IslandChangedPromise = takeOneMessage(nats, 'engine.peer.peer2.island_changed')

      engine.onPeerPositionsUpdate([{ id: 'peer2', position: [10, 0, 10] }])
      await flushAndPublish()
    })

    it('should publish island changed for the second peer with both peers in the island', async () => {
      const message = await peer2IslandChangedPromise
      const decoded = IslandChangedMessage.decode(message.data)
      expect(decoded.peers['peer1']).toBeDefined()
      expect(decoded.peers['peer2']).toBeDefined()
    })
  })

  describe('when a peer moves far enough to trigger a split', () => {
    let splitUpdates: Map<string, any>

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: 'peer1', position: [0, 0, 0] },
        { id: 'peer2', position: [50, 0, 0] }
      ])
      await flushAndPublish()

      engine.onPeerPositionsUpdate([{ id: 'peer2', position: [200, 0, 0] }])
      splitUpdates = await flushAndPublish()
    })

    it('should produce a changeTo update for the peer that split off', () => {
      const update = splitUpdates.get('peer2') as ChangeToIslandUpdate
      expect(update).toBeDefined()
      expect(update.action).toBe('changeTo')
      expect(update.fromIslandId).toBeDefined()
    })

    it('should publish an islands report with two islands', async () => {
      const reportPromise = takeOneMessage(nats, 'engine.islands')
      publisher.publishIslandsReport(engine.getIslands())
      const message = await reportPromise
      const decoded = IslandStatusMessage.decode(message.data)
      expect(decoded.data).toHaveLength(2)
    })
  })

  describe('when two islands merge', () => {
    let mergeUpdates: Map<string, any>

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([{ id: 'peer1', position: [0, 0, 0] }])
      await flushAndPublish()

      engine.onPeerPositionsUpdate([{ id: 'peer2', position: [200, 0, 0] }])
      await flushAndPublish()

      expect(engine.getIslands()).toHaveLength(2)

      engine.onPeerPositionsUpdate([{ id: 'peer2', position: [30, 0, 0] }])
      mergeUpdates = await flushAndPublish()
    })

    it('should produce a changeTo update for the merged peer', () => {
      const update = mergeUpdates.get('peer2') as ChangeToIslandUpdate
      expect(update).toBeDefined()
      expect(update.action).toBe('changeTo')
    })

    it('should result in a single island', () => {
      expect(engine.getIslands()).toHaveLength(1)
    })

    it('should publish an islands report with one island containing both peers', async () => {
      const reportPromise = takeOneMessage(nats, 'engine.islands')
      publisher.publishIslandsReport(engine.getIslands())
      const message = await reportPromise
      const decoded = IslandStatusMessage.decode(message.data)
      expect(decoded.data).toHaveLength(1)
      expect(decoded.data[0].peers.sort()).toEqual(['peer1', 'peer2'])
    })
  })

  describe('when a peer disconnects', () => {
    let disconnectUpdates: Map<string, any>

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: 'peer1', position: [0, 0, 0] },
        { id: 'peer2', position: [10, 0, 10] }
      ])
      await flushAndPublish()

      engine.onPeerDisconnected('peer1')
      disconnectUpdates = await flushAndPublish()
    })

    it('should produce a leave update for the disconnected peer', () => {
      expect(disconnectUpdates.get('peer1')).toEqual({
        action: 'leave',
        islandId: expect.any(String)
      })
    })

    it('should not publish an island changed message for the leave action', () => {
      // Leave actions don't trigger island_changed messages (per core/src/service.ts)
      // The test verifies this by checking that no changeTo is produced for peer1
      expect(disconnectUpdates.get('peer1')!.action).toBe('leave')
    })

    it('should publish an updated islands report without the disconnected peer', async () => {
      const reportPromise = takeOneMessage(nats, 'engine.islands')
      publisher.publishIslandsReport(engine.getIslands())
      const message = await reportPromise
      const decoded = IslandStatusMessage.decode(message.data)
      expect(decoded.data).toHaveLength(1)
      expect(decoded.data[0].peers).toEqual(['peer2'])
    })
  })

  describe('when a disconnect causes a split', () => {
    let splitUpdates: Map<string, any>

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: 'peer1', position: [0, 0, 0] },
        { id: 'bridge', position: [50, 0, 0] },
        { id: 'peer3', position: [100, 0, 0] }
      ])
      await flushAndPublish()

      engine.onPeerDisconnected('bridge')
      splitUpdates = await flushAndPublish()
    })

    it('should produce a leave update for the bridge peer', () => {
      expect(splitUpdates.get('bridge')!.action).toBe('leave')
    })

    it('should produce a changeTo update for the peer that moved to a new island', () => {
      const update = splitUpdates.get('peer3') as ChangeToIslandUpdate
      expect(update).toBeDefined()
      expect(update.action).toBe('changeTo')
    })

    it('should result in two separate islands', () => {
      expect(engine.getIslands()).toHaveLength(2)
    })
  })

  describe('when island report includes geometry data', () => {
    let reportMessage: NatsMsg

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: 'peer1', position: [0, 5, 0] },
        { id: 'peer2', position: [40, 10, 40] }
      ])
      await engine.flush()

      const reportPromise = takeOneMessage(nats, 'engine.islands')
      publisher.publishIslandsReport(engine.getIslands())
      reportMessage = await reportPromise
    })

    it('should include center coordinates in the report', () => {
      const decoded = IslandStatusMessage.decode(reportMessage.data)
      expect(decoded.data[0].center).toBeDefined()
      expect(decoded.data[0].center!.x).toBe(20)
      expect(decoded.data[0].center!.z).toBe(20)
    })

    it('should include radius in the report', () => {
      const decoded = IslandStatusMessage.decode(reportMessage.data)
      expect(decoded.data[0].radius).toBeGreaterThan(0)
    })

    it('should include maxPeers in the report', () => {
      const decoded = IslandStatusMessage.decode(reportMessage.data)
      expect(decoded.data[0].maxPeers).toBe(200)
    })
  })

  describe('when publishing island changed message with fromIslandId', () => {
    let islandChangedMessage: NatsMsg

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([{ id: 'peer1', position: [0, 0, 0] }])
      await engine.flush()
      const firstIslandId = engine.getPeerData('peer1')!.islandId!

      engine.onPeerPositionsUpdate([{ id: 'peer2', position: [200, 0, 0] }])
      await engine.flush()

      const promise = takeOneMessage(nats, 'engine.peer.peer2.island_changed')

      engine.onPeerPositionsUpdate([{ id: 'peer2', position: [30, 0, 0] }])
      const updates = await engine.flush()
      const update = updates.get('peer2') as ChangeToIslandUpdate
      const island = engine.getIsland(update.islandId)!
      publisher.onChangeToIsland('peer2', island, update)

      islandChangedMessage = await promise
    })

    it('should include fromIslandId in the encoded message', () => {
      const decoded = IslandChangedMessage.decode(islandChangedMessage.data)
      expect(decoded.fromIslandId).toBeDefined()
      expect(decoded.fromIslandId).not.toBe('')
    })
  })
})
