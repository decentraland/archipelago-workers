import { Engine, ChangeToIslandUpdate } from '../../src/types'
import { expectIslandWith } from '../helpers/archipelago'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createArchipelagoEngine } from '../../src/adapters/engine'

/**
 * These tests verify the engine handles state mutations that occur during
 * async transport operations. In production, NATS callbacks (onPeerDisconnected,
 * onPeerPositionsUpdate) can fire during the await in transport.getConnectionStrings(),
 * modifying the engine's internal state mid-operation.
 *
 * We simulate this by injecting side effects into getConnectionStrings.
 */
describe('engine concurrency: state mutation during async transport calls', () => {
  describe('when a peer disconnects during mergeIntoIfPossible await', () => {
    let engine: Engine

    beforeEach(async () => {
      let disconnectDuringMerge = false
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
          async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            // When getting conn strings for the merge (source-peer into target island),
            // simulate a disconnect of the target island's sole peer
            if (disconnectDuringMerge && userIds.includes('source-peer') && engine.getPeerData('source-peer')?.islandId) {
              disconnectDuringMerge = false
              await new Promise((resolve) => setTimeout(resolve, 1))
              engine.onPeerDisconnected('target-sole-peer')
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return connStrs
          }
        }
      })

      // Create target island with one peer
      engine.onPeerPositionsUpdate([{ id: 'target-sole-peer', position: [0, 0, 0] }])
      await engine.flush()

      // Create source island far away
      engine.onPeerPositionsUpdate([{ id: 'source-peer', position: [200, 0, 0] }])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(2)

      // Enable the disconnect trigger for the next merge
      disconnectDuringMerge = true
    })

    it('should not leave source peer pointing to a deleted island', async () => {
      engine.onPeerPositionsUpdate([{ id: 'source-peer', position: [10, 0, 0] }])
      await engine.flush()

      const sourcePeer = engine.getPeerData('source-peer')
      expect(sourcePeer).toBeDefined()
      if (sourcePeer && sourcePeer.islandId) {
        const island = engine.getIsland(sourcePeer.islandId)
        expect(island).toBeDefined()
      }
    })

    it('should not crash on subsequent heartbeat after the merge race', async () => {
      engine.onPeerPositionsUpdate([{ id: 'source-peer', position: [10, 0, 0] }])
      await engine.flush()

      // This heartbeat would crash if source-peer.islandId points to a deleted island:
      // onPeerPositionsUpdate does islands.get(peer.islandId)!._geometryDirty = true
      engine.onPeerPositionsUpdate([{ id: 'source-peer', position: [15, 0, 0] }])
      await expect(engine.flush()).resolves.toBeDefined()
    })
  })

  describe('when a peer disconnects during createIsland await in split phase', () => {
    let engine: Engine

    beforeEach(async () => {
      let disconnectDuringSplit = false
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
          async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            // When creating an island for the split-off peer, disconnect it during the await
            if (disconnectDuringSplit && userIds.includes('splitting-peer')) {
              disconnectDuringSplit = false
              await new Promise((resolve) => setTimeout(resolve, 1))
              engine.onPeerDisconnected('splitting-peer')
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return connStrs
          }
        }
      })

      // Create an island with two peers
      engine.onPeerPositionsUpdate([
        { id: 'staying-peer', position: [0, 0, 0] },
        { id: 'splitting-peer', position: [10, 0, 0] }
      ])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(1)

      // Enable the disconnect trigger for the next split
      disconnectDuringSplit = true
    })

    it('should not leave a ghost peer in the newly created island', async () => {
      // Move splitting-peer far away to trigger a split
      engine.onPeerPositionsUpdate([{ id: 'splitting-peer', position: [200, 0, 0] }])
      await engine.flush() // call 2: split -> createIsland for splitting-peer -> peer disconnects during await

      // The disconnected peer should not be in any island's peers array
      for (const island of engine.getIslands()) {
        const ghostPeer = island.peers.find((p) => p.id === 'splitting-peer')
        expect(ghostPeer).toBeUndefined()
      }

      // The disconnected peer should not be in the peers map
      expect(engine.getPeerData('splitting-peer')).toBeUndefined()

      // Subsequent operations should not crash
      engine.onPeerPositionsUpdate([{ id: 'staying-peer', position: [5, 0, 5] }])
      const updates = await engine.flush()
      expect(updates.size).toBe(0) // no crash
    })
  })

  describe('when a peer in the source island disconnects during merge await', () => {
    let engine: Engine

    beforeEach(async () => {
      let mergeCallTriggered = false
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
          async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            // When merging source-peer into the target island, disconnect source-peer
            if (userIds.includes('source-peer') && !mergeCallTriggered) {
              if (engine.getPeerData('source-peer')?.islandId) {
                mergeCallTriggered = true
                await new Promise((resolve) => setTimeout(resolve, 1))
                engine.onPeerDisconnected('source-peer')
              }
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return connStrs
          }
        }
      })

      // Create two islands
      engine.onPeerPositionsUpdate([{ id: 'target-peer', position: [0, 0, 0] }])
      await engine.flush()

      engine.onPeerPositionsUpdate([{ id: 'source-peer', position: [200, 0, 0] }])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(2)
    })

    it('should not add a disconnected peer to the target island', async () => {
      // Move source close to trigger merge
      engine.onPeerPositionsUpdate([{ id: 'source-peer', position: [10, 0, 0] }])
      await engine.flush()

      // source-peer disconnected during the merge — should not be in any island
      expect(engine.getPeerData('source-peer')).toBeUndefined()

      for (const island of engine.getIslands()) {
        const ghost = island.peers.find((p) => p.id === 'source-peer')
        expect(ghost).toBeUndefined()
      }
    })
  })

  describe('when a peer disconnects during merge and overwrites its pending changeTo', () => {
    let engine: Engine

    beforeEach(async () => {
      let disconnectDuringMerge = false
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
          async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            if (disconnectDuringMerge && userIds.includes('moving-peer') && engine.getPeerData('moving-peer')?.islandId) {
              disconnectDuringMerge = false
              await new Promise((resolve) => setTimeout(resolve, 1))
              engine.onPeerDisconnected('moving-peer')
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return connStrs
          }
        }
      })

      // Create island with moving-peer, then a separate target island
      engine.onPeerPositionsUpdate([
        { id: 'anchor', position: [0, 0, 0] },
        { id: 'moving-peer', position: [10, 0, 0] }
      ])
      await engine.flush()

      engine.onPeerPositionsUpdate([{ id: 'target-peer', position: [500, 0, 0] }])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(2)

      disconnectDuringMerge = true
    })

    it('should produce a leave update instead of a stale changeTo', async () => {
      // Move peer far from anchor (triggers split) and close to target (triggers merge)
      // Disconnect fires during the merge await
      engine.onPeerPositionsUpdate([{ id: 'moving-peer', position: [490, 0, 0] }])
      const updates = await engine.flush()

      // The peer disconnected during the merge. The leave update should be present.
      const update = updates.get('moving-peer')
      if (update) {
        expect(update.action).toBe('leave')
      }

      // The peer should not be in any island
      expect(engine.getPeerData('moving-peer')).toBeUndefined()
    })
  })

  describe('when multiple peers disconnect during a single flush await', () => {
    let engine: Engine

    beforeEach(async () => {
      let disconnectsTriggered = false
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
          async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            if (disconnectsTriggered && userIds.includes('peer-c')) {
              disconnectsTriggered = false
              await new Promise((resolve) => setTimeout(resolve, 1))
              // Multiple peers disconnect at once
              engine.onPeerDisconnected('peer-a')
              engine.onPeerDisconnected('peer-b')
              engine.onPeerDisconnected('peer-c')
            }
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return connStrs
          }
        }
      })

      engine.onPeerPositionsUpdate([
        { id: 'peer-a', position: [0, 0, 0] },
        { id: 'peer-b', position: [10, 0, 10] },
        { id: 'peer-c', position: [50, 0, 0] }
      ])
      await engine.flush()

      expect(engine.getIslands()).toHaveLength(1)

      disconnectsTriggered = true
    })

    it('should leave no ghost peers and no islands', async () => {
      // Trigger a split that would create a new island for peer-c,
      // but all peers disconnect during the createIsland await
      engine.onPeerPositionsUpdate([{ id: 'peer-c', position: [200, 0, 0] }])
      await engine.flush()

      // All peers should be gone
      expect(engine.getPeerData('peer-a')).toBeUndefined()
      expect(engine.getPeerData('peer-b')).toBeUndefined()
      expect(engine.getPeerData('peer-c')).toBeUndefined()

      // No ghost peers in any island
      for (const island of engine.getIslands()) {
        for (const peer of island.peers) {
          expect(engine.getPeerData(peer.id)).toBeDefined()
        }
      }

      expect(engine.getPeerCount()).toBe(0)
    })
  })

  describe('peer reference integrity: no peer appears in two islands', () => {
    let engine: Engine

    beforeEach(async () => {
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
          async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
            const connStrs: Record<string, string> = {}
            for (const userId of userIds) {
              connStrs[userId] = `test:${roomId}.${userId}`
            }
            return connStrs
          }
        }
      })
    })

    function assertNoPeerDuplication() {
      const seenPeerIds = new Set<string>()
      for (const island of engine.getIslands()) {
        for (const peer of island.peers) {
          expect(seenPeerIds.has(peer.id)).toBe(false)
          seenPeerIds.add(peer.id)
          // Every peer in an island should point back to that island
          expect(peer.islandId).toBe(island.id)
        }
      }
    }

    it('should maintain integrity after split', async () => {
      engine.onPeerPositionsUpdate([
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [10, 0, 10] },
        { id: 'c', position: [50, 0, 0] }
      ])
      await engine.flush()

      // Split c away
      engine.onPeerPositionsUpdate([{ id: 'c', position: [200, 0, 0] }])
      await engine.flush()

      assertNoPeerDuplication()
    })

    it('should maintain integrity after merge', async () => {
      engine.onPeerPositionsUpdate([{ id: 'a', position: [0, 0, 0] }])
      await engine.flush()
      engine.onPeerPositionsUpdate([{ id: 'b', position: [200, 0, 0] }])
      await engine.flush()

      // Move b close to a to trigger merge
      engine.onPeerPositionsUpdate([{ id: 'b', position: [10, 0, 0] }])
      await engine.flush()

      assertNoPeerDuplication()
    })

    it('should maintain integrity after split followed by merge in same flush', async () => {
      engine.onPeerPositionsUpdate([
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [10, 0, 0] },
        { id: 'c', position: [50, 0, 0] }
      ])
      await engine.flush()

      engine.onPeerPositionsUpdate([{ id: 'd', position: [500, 0, 0] }])
      await engine.flush()

      // Split c away from a,b AND merge c into d's island
      engine.onPeerPositionsUpdate([{ id: 'c', position: [490, 0, 0] }])
      await engine.flush()

      assertNoPeerDuplication()
    })

    it('should maintain integrity after rapid position changes across multiple flushes', async () => {
      engine.onPeerPositionsUpdate([
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [10, 0, 0] },
        { id: 'c', position: [20, 0, 0] }
      ])
      await engine.flush()

      // Scatter
      engine.onPeerPositionsUpdate([
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [200, 0, 0] },
        { id: 'c', position: [400, 0, 0] }
      ])
      await engine.flush()
      assertNoPeerDuplication()

      // Regroup
      engine.onPeerPositionsUpdate([
        { id: 'b', position: [10, 0, 0] },
        { id: 'c', position: [20, 0, 0] }
      ])
      await engine.flush()
      assertNoPeerDuplication()

      // Add peers and scatter again
      engine.onPeerPositionsUpdate([
        { id: 'd', position: [0, 0, 0] },
        { id: 'e', position: [500, 0, 0] }
      ])
      await engine.flush()

      engine.onPeerDisconnected('b')
      engine.onPeerPositionsUpdate([{ id: 'c', position: [490, 0, 0] }])
      await engine.flush()
      assertNoPeerDuplication()
    })
  })
})
