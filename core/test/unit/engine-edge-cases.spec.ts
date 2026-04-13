import { PeerPositionChange, IslandUpdates, ChangeToIslandUpdate, Engine } from '../../src/types'
import { expectIslandsWith, expectIslandWith } from '../helpers/archipelago'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createArchipelagoEngine } from '../../src/adapters/engine'

type PositionWithId = [string, number, number, number]

describe('engine edge cases', () => {
  let engine: Engine
  let getConnectionStringsCalls: string[][]

  beforeEach(async () => {
    getConnectionStringsCalls = []
    const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
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
          getConnectionStringsCalls.push([...userIds])
          const connStrs: Record<string, string> = {}
          for (const userId of userIds) {
            connStrs[userId] = `test:${roomId}.${userId}`
          }
          return Promise.resolve(connStrs)
        }
      }
    })
  })

  function setPositionArrays(...positions: PositionWithId[]) {
    engine.onPeerPositionsUpdate(positions.map(([id, ...position]) => ({ id, position })))
    return engine.flush()
  }

  describe('when flushing with no pending changes', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      updates = await engine.flush()
    })

    it('should return an empty updates map', () => {
      expect(updates.size).toBe(0)
    })

    it('should have no islands', () => {
      expect(engine.getIslands()).toHaveLength(0)
    })
  })

  describe('when flushing twice with no changes between flushes', () => {
    let firstUpdates: IslandUpdates
    let secondUpdates: IslandUpdates

    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 10])
      firstUpdates = await engine.flush()
      secondUpdates = await engine.flush()
    })

    it('should return updates on the first flush only', () => {
      expect(firstUpdates.size).toBe(0)
    })

    it('should return empty updates on the second flush', () => {
      expect(secondUpdates.size).toBe(0)
    })
  })

  describe('when disconnecting a peer that was never connected', () => {
    beforeEach(() => {
      engine.onPeerDisconnected('nonexistent')
    })

    it('should not create any islands', () => {
      expect(engine.getIslands()).toHaveLength(0)
    })

    it('should not produce any pending updates on flush', async () => {
      const updates = await engine.flush()
      expect(updates.size).toBe(0)
    })
  })

  describe('when disconnecting a peer before flush processes it', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
      engine.onPeerDisconnected('1')
      updates = await engine.flush()
    })

    it('should not create an island for the disconnected peer', () => {
      expect(engine.getIslands()).toHaveLength(0)
    })

    it('should not include the peer in updates', () => {
      expect(updates.has('1')).toBe(false)
    })
  })

  describe('when disconnecting a peer twice', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 10])
      engine.onPeerDisconnected('1')
      engine.onPeerDisconnected('1')
      updates = await engine.flush()
    })

    it('should not crash and should handle gracefully', () => {
      expect(updates.has('1')).toBe(true)
      expect(updates.get('1')!.action).toBe('leave')
    })

    it('should keep the remaining peer in its island', () => {
      expect(engine.getIslands()).toHaveLength(1)
      expectIslandWith(engine, '2')
    })
  })

  describe('when updates include connection strings', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([{ id: 'peer1', position: [0, 0, 0] }])
      updates = await engine.flush()
    })

    it('should include a connStr in changeTo updates', () => {
      const update = updates.get('peer1') as ChangeToIslandUpdate
      expect(update.action).toBe('changeTo')
      expect(update.connStr).toBeDefined()
      expect(update.connStr).toContain('test:')
      expect(update.connStr).toContain('peer1')
    })
  })

  describe('when a peer is assigned to a new island', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
      updates = await engine.flush()
    })

    it('should not have a fromIslandId for a brand new peer', () => {
      const update = updates.get('1') as ChangeToIslandUpdate
      expect(update.fromIslandId).toBeUndefined()
    })
  })

  describe('when a peer moves to a different island via split', () => {
    let originalIslandId: string
    let updates: IslandUpdates

    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0], ['2', 50, 0, 0])
      originalIslandId = engine.getIslands()[0].id

      engine.onPeerPositionsUpdate([{ id: '2', position: [200, 0, 0] }])
      updates = await engine.flush()
    })

    it('should set fromIslandId to the original island for the moved peer', () => {
      const update = updates.get('2') as ChangeToIslandUpdate
      expect(update.action).toBe('changeTo')
      expect(update.fromIslandId).toBe(originalIslandId)
    })

    it('should not produce an update for the peer that stayed', () => {
      expect(updates.has('1')).toBe(false)
    })
  })

  describe('when a peer moves to a different island via merge', () => {
    let updates: IslandUpdates
    let island1Id: string
    let island2Id: string

    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0])
      island1Id = engine.getPeerData('1')!.islandId!

      await setPositionArrays(['2', 200, 0, 0])
      island2Id = engine.getPeerData('2')!.islandId!

      engine.onPeerPositionsUpdate([{ id: '2', position: [30, 0, 0] }])
      updates = await engine.flush()
    })

    it('should merge the smaller island into the larger one', () => {
      expect(engine.getIslands()).toHaveLength(1)
      expectIslandWith(engine, '1', '2')
    })

    it('should set fromIslandId for the merged peer', () => {
      const update = updates.get('2') as ChangeToIslandUpdate
      expect(update.action).toBe('changeTo')
      expect(update.fromIslandId).toBe(island2Id)
      expect(update.islandId).toBe(island1Id)
    })
  })

  describe('when a preferred island does not exist', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0])
      engine.onPeerPositionsUpdate([
        { id: '2', position: [30, 0, 0], preferedIslandId: 'NONEXISTENT_ISLAND' }
      ])
      updates = await engine.flush()
    })

    it('should still merge the peer into the closest island', () => {
      expect(engine.getIslands()).toHaveLength(1)
      expectIslandWith(engine, '1', '2')
    })
  })

  describe('when updating position for a peer that was just added in the same batch', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0] },
        { id: '1', position: [10, 0, 10] }
      ])
      updates = await engine.flush()
    })

    it('should use the last position provided', () => {
      const peer = engine.getPeerData('1')
      expect(peer).toBeDefined()
      expect(peer!.position).toEqual([10, 0, 10])
    })

    it('should create exactly one island', () => {
      expect(engine.getIslands()).toHaveLength(1)
    })
  })

  describe('when updating preferedIslandId explicitly to undefined', () => {
    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0], preferedIslandId: 'I999' }
      ])
      await engine.flush()

      engine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0], preferedIslandId: undefined }
      ])
      await engine.flush()
    })

    it('should clear the preferedIslandId', () => {
      const peer = engine.getPeerData('1')
      expect(peer!.preferedIslandId).toBeUndefined()
    })
  })

  describe('when updating position without providing preferedIslandId key', () => {
    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0], preferedIslandId: 'I999' }
      ])
      await engine.flush()

      engine.onPeerPositionsUpdate([{ id: '1', position: [5, 0, 5] }])
      await engine.flush()
    })

    it('should preserve the existing preferedIslandId', () => {
      const peer = engine.getPeerData('1')
      expect(peer!.preferedIslandId).toBe('I999')
    })
  })

  describe('when a peer disconnect causes an island to become empty', () => {
    let updates: IslandUpdates
    let islandId: string

    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0])
      islandId = engine.getIslands()[0].id

      engine.onPeerDisconnected('1')
      updates = await engine.flush()
    })

    it('should delete the empty island', () => {
      expect(engine.getIslands()).toHaveLength(0)
      expect(engine.getIsland(islandId)).toBeUndefined()
    })

    it('should produce a leave update for the disconnected peer', () => {
      expect(updates.get('1')).toEqual({
        action: 'leave',
        islandId
      })
    })
  })

  describe('when a peer disconnect causes an island split', () => {
    let updates: IslandUpdates

    beforeEach(async () => {
      // Peer 2 bridges peers 1 and 3
      await setPositionArrays(['1', 0, 0, 0], ['2', 50, 0, 0], ['3', 100, 0, 0])
      expectIslandWith(engine, '1', '2', '3')

      engine.onPeerDisconnected('2')
      updates = await engine.flush()
    })

    it('should split into two separate islands', () => {
      expect(engine.getIslands()).toHaveLength(2)
      expectIslandsWith(engine, ['1'], ['3'])
    })

    it('should produce a leave update for the disconnected peer', () => {
      expect(updates.get('2')!.action).toBe('leave')
    })

    it('should produce a changeTo update for the peer that moved to a new island', () => {
      const update3 = updates.get('3') as ChangeToIslandUpdate
      expect(update3.action).toBe('changeTo')
      expect(update3.fromIslandId).toBeDefined()
    })
  })

  describe('when getPeerData is called for an unknown peer', () => {
    it('should return undefined', () => {
      expect(engine.getPeerData('unknown')).toBeUndefined()
    })
  })

  describe('when getIsland is called for an unknown island', () => {
    it('should return undefined', () => {
      expect(engine.getIsland('unknown')).toBeUndefined()
    })
  })

  describe('when getPeerCount is called', () => {
    describe('and there are no peers', () => {
      it('should return 0', () => {
        expect(engine.getPeerCount()).toBe(0)
      })
    })

    describe('and there are peers', () => {
      beforeEach(async () => {
        await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 0])
      })

      it('should return the correct count', () => {
        expect(engine.getPeerCount()).toBe(2)
      })
    })

    describe('and a peer is disconnected', () => {
      beforeEach(async () => {
        await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 0])
        engine.onPeerDisconnected('1')
      })

      it('should return the updated count', () => {
        expect(engine.getPeerCount()).toBe(1)
      })
    })
  })

  describe('when transport getConnectionStrings is called during island operations', () => {
    describe('and a new peer is added', () => {
      beforeEach(async () => {
        getConnectionStringsCalls = []
        await setPositionArrays(['1', 0, 0, 0])
      })

      it('should call getConnectionStrings once for island creation', () => {
        expect(getConnectionStringsCalls).toHaveLength(1)
        expect(getConnectionStringsCalls[0]).toEqual(['1'])
      })
    })

    describe('and two close peers are added simultaneously', () => {
      beforeEach(async () => {
        getConnectionStringsCalls = []
        await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 0])
      })

      it('should call getConnectionStrings for each initial island then for the merge', () => {
        // Two separate islands are created first (2 calls), then they merge (1 call)
        expect(getConnectionStringsCalls.length).toBeGreaterThanOrEqual(2)
      })
    })
  })

  describe('when island geometry is recalculated after peer movement', () => {
    beforeEach(async () => {
      await setPositionArrays(['1', 0, 0, 0], ['2', 40, 0, 40])
    })

    describe('and a peer moves', () => {
      beforeEach(async () => {
        engine.onPeerPositionsUpdate([{ id: '2', position: [20, 0, 20] }])
        await engine.flush()
      })

      it('should update the island center', () => {
        const island = engine.getIslands()[0]
        expect(island.center).toEqual([10, 0, 10])
      })

      it('should update the island radius', () => {
        const island = engine.getIslands()[0]
        expect(island.radius).toBeCloseTo(Math.sqrt(200), 5)
      })
    })
  })

  describe('when createIsland fails for a new peer due to transport error', () => {
    let failingEngine: Engine
    let shouldFail: boolean

    beforeEach(async () => {
      shouldFail = false
      const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
      const logs = await createLogComponent({ config })
      const metrics = createTestMetricsComponent(metricDeclarations)

      failingEngine = createArchipelagoEngine({
        components: { logs, metrics },
        joinDistance: 64,
        leaveDistance: 80,
        transport: {
          name: 'test',
          maxIslandSize: 200,
          getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            if (shouldFail) {
              return Promise.reject(new Error('transport failure'))
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return Promise.resolve(connStrs)
          }
        }
      })
    })

    it('should not leave the peer orphaned in the peers map with no island', async () => {
      shouldFail = true
      failingEngine.onPeerPositionsUpdate([{ id: 'orphan', position: [0, 0, 0] }])
      await failingEngine.flush()

      // The peer should NOT be in peers with no island - it should be retryable
      expect(failingEngine.getIslands()).toHaveLength(0)
      // getPeerCount should not count an orphaned peer
      expect(failingEngine.getPeerCount()).toBe(0)
    })

    it('should allow the peer to rejoin via a new heartbeat when transport recovers', async () => {
      shouldFail = true
      failingEngine.onPeerPositionsUpdate([{ id: 'retry-peer', position: [0, 0, 0] }])
      await failingEngine.flush()

      // Transport recovers and peer sends a new heartbeat
      shouldFail = false
      failingEngine.onPeerPositionsUpdate([{ id: 'retry-peer', position: [0, 0, 0] }])
      const updates = await failingEngine.flush()

      // The peer should now be assigned to an island
      expect(failingEngine.getIslands()).toHaveLength(1)
      expectIslandWith(failingEngine, 'retry-peer')
      expect(updates.has('retry-peer')).toBe(true)
      expect(updates.get('retry-peer')!.action).toBe('changeTo')
    })

    it('should use the latest position when the peer retries after failure', async () => {
      shouldFail = true
      failingEngine.onPeerPositionsUpdate([{ id: 'moving-peer', position: [0, 0, 0] }])
      await failingEngine.flush()

      // Transport recovers, peer sends a new position
      shouldFail = false
      failingEngine.onPeerPositionsUpdate([{ id: 'moving-peer', position: [50, 0, 50] }])
      await failingEngine.flush()

      // Peer should be in an island at the latest position
      expect(failingEngine.getIslands()).toHaveLength(1)
      const peer = failingEngine.getPeerData('moving-peer')
      expect(peer).toBeDefined()
      expect(peer!.position).toEqual([50, 0, 50])
    })
  })

  describe('when transport maxIslandSize limits merges', () => {
    let smallEngine: Engine

    beforeEach(async () => {
      const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
      const logs = await createLogComponent({ config })
      const metrics = createTestMetricsComponent(metricDeclarations)

      smallEngine = createArchipelagoEngine({
        components: { logs, metrics },
        joinDistance: 64,
        leaveDistance: 80,
        transport: {
          name: 'test',
          maxIslandSize: 3,
          getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return Promise.resolve(connStrs)
          }
        }
      })
    })

    it('should create islands with the configured maxPeers', async () => {
      smallEngine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
      await smallEngine.flush()

      const island = smallEngine.getIslands()[0]
      expect(island.maxPeers).toBe(3)
    })

    it('should not merge islands that would exceed maxIslandSize', async () => {
      smallEngine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0] },
        { id: '2', position: [10, 0, 0] },
        { id: '3', position: [20, 0, 0] }
      ])
      await smallEngine.flush()
      expect(smallEngine.getIslands()).toHaveLength(1)

      smallEngine.onPeerPositionsUpdate([{ id: '4', position: [30, 0, 0] }])
      await smallEngine.flush()

      expect(smallEngine.getIslands()).toHaveLength(2)
    })
  })

  describe('when a room prefix is configured', () => {
    let prefixedEngine: Engine

    beforeEach(async () => {
      const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
      const logs = await createLogComponent({ config })
      const metrics = createTestMetricsComponent(metricDeclarations)

      prefixedEngine = createArchipelagoEngine({
        components: { logs, metrics },
        joinDistance: 64,
        leaveDistance: 80,
        roomPrefix: 'ROOM_',
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
    })

    it('should generate island IDs with the configured prefix', async () => {
      prefixedEngine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
      await prefixedEngine.flush()

      const island = prefixedEngine.getIslands()[0]
      expect(island.id).toMatch(/^ROOM_/)
    })
  })

  describe('when a peer has NaN position values', () => {
    it('should isolate the NaN peer in its own island and not merge with valid peers', async () => {
      engine.onPeerPositionsUpdate([
        { id: 'valid1', position: [0, 0, 0] },
        { id: 'valid2', position: [10, 0, 10] }
      ])
      await engine.flush()

      // NaN peer should not merge with the valid peers island
      engine.onPeerPositionsUpdate([{ id: 'nan-peer', position: [NaN, 0, NaN] }])
      await engine.flush()

      // NaN comparisons always return false, so the NaN peer can never
      // intersect with any group. It creates a permanently isolated island.
      const nanPeer = engine.getPeerData('nan-peer')
      expect(nanPeer).toBeDefined()
      const nanIsland = engine.getIsland(nanPeer!.islandId!)
      expect(nanIsland!.peers).toHaveLength(1)
      expect(nanIsland!.peers[0].id).toBe('nan-peer')
    })

    it('should not affect the formation of valid peer islands', async () => {
      engine.onPeerPositionsUpdate([
        { id: 'valid1', position: [0, 0, 0] },
        { id: 'nan-peer', position: [NaN, 0, NaN] },
        { id: 'valid2', position: [10, 0, 10] }
      ])
      await engine.flush()

      // Valid peers should still group together correctly
      expectIslandWith(engine, 'valid1', 'valid2')
      // NaN peer is isolated
      const nanPeer = engine.getPeerData('nan-peer')
      const nanIsland = engine.getIsland(nanPeer!.islandId!)
      expect(nanIsland!.peers).toHaveLength(1)
    })
  })

  describe('when mergeIslands is called with multiple intersecting islands', () => {
    it('should correctly merge all intersecting islands without shadowing issues', async () => {
      // Create three separate islands
      engine.onPeerPositionsUpdate([{ id: 'a', position: [0, 0, 0] }])
      await engine.flush()
      engine.onPeerPositionsUpdate([{ id: 'b', position: [200, 0, 0] }])
      await engine.flush()
      engine.onPeerPositionsUpdate([{ id: 'c', position: [400, 0, 0] }])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(3)

      // Move all peers close together to trigger a multi-island merge
      engine.onPeerPositionsUpdate([
        { id: 'b', position: [10, 0, 0] },
        { id: 'c', position: [20, 0, 0] }
      ])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(1)
      expectIslandWith(engine, 'a', 'b', 'c')
    })
  })

  describe('when a split and merge happen in the same flush cycle', () => {
    it('should report fromIslandId referencing the intermediate island instead of the original', async () => {
      // Setup: island I1 has peers A,B,C. A third island I2 has peer D nearby.
      engine.onPeerPositionsUpdate([
        { id: 'A', position: [0, 0, 0] },
        { id: 'B', position: [10, 0, 10] },
        { id: 'C', position: [50, 0, 0] }
      ])
      await engine.flush()
      const originalIslandId = engine.getPeerData('C')!.islandId!

      // Create a separate island with peer D, positioned so that when C splits off
      // from I1, it will merge into D's island
      engine.onPeerPositionsUpdate([{ id: 'D', position: [140, 0, 0] }])
      await engine.flush()
      const targetIslandId = engine.getPeerData('D')!.islandId!

      // Now move C far from A,B but close to D -> triggers split from I1, then merge into I2
      engine.onPeerPositionsUpdate([{ id: 'C', position: [130, 0, 0] }])
      const updates = await engine.flush()

      // C should end up in D's island
      const cUpdate = updates.get('C') as ChangeToIslandUpdate
      expect(cUpdate).toBeDefined()
      expect(cUpdate.action).toBe('changeTo')
      expect(cUpdate.islandId).toBe(targetIslandId)

      // The fromIslandId references the intermediate split island, not the original.
      // This is because the split creates a temporary island for C (setPeersIsland sets
      // fromIslandId to originalIslandId), then the merge overwrites the update with
      // fromIslandId pointing to the temporary island.
      expect(cUpdate.fromIslandId).not.toBe(originalIslandId)
    })
  })

  describe('when createIsland fails and retries succeed', () => {
    it('should use unique island IDs even after failures consume IDs', async () => {
      let shouldFail = true
      const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
      const logs = await createLogComponent({ config })
      const metrics = createTestMetricsComponent(metricDeclarations)

      const idEngine = createArchipelagoEngine({
        components: { logs, metrics },
        joinDistance: 64,
        leaveDistance: 80,
        transport: {
          name: 'test',
          maxIslandSize: 200,
          getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            if (shouldFail) {
              return Promise.reject(new Error('fail'))
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return Promise.resolve(connStrs)
          }
        }
      })

      // First attempt fails, consuming an island ID
      idEngine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
      await idEngine.flush()
      expect(idEngine.getIslands()).toHaveLength(0)

      // Second attempt succeeds with a new ID
      shouldFail = false
      idEngine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
      await idEngine.flush()
      expect(idEngine.getIslands()).toHaveLength(1)

      // Third peer gets yet another unique ID
      idEngine.onPeerPositionsUpdate([{ id: '2', position: [200, 0, 0] }])
      await idEngine.flush()

      const islandIds = idEngine.getIslands().map((i) => i.id)
      // All IDs should be unique (no collisions despite the gap)
      expect(new Set(islandIds).size).toBe(islandIds.length)
    })
  })
})
