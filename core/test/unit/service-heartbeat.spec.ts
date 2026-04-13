import { Heartbeat } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createArchipelagoEngine } from '../../src/adapters/engine'
import { Engine } from '../../src/types'

/**
 * These tests verify the service loop behavior for heartbeat tracking and peer
 * disconnect/reconnect scenarios. They replicate the logic from core/src/service.ts
 * without starting the full lifecycle.
 */
describe('service heartbeat tracking', () => {
  let engine: Engine
  let nats: INatsComponent
  let lastPeerHeartbeats: Map<string, number>
  const CHECK_HEARTBEAT_INTERVAL = 60000

  beforeEach(async () => {
    nats = await createLocalNatsComponent()
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
          const connStrs: Record<string, string> = {}
          for (const userId of userIds) {
            connStrs[userId] = `test:${roomId}.${userId}`
          }
          return Promise.resolve(connStrs)
        }
      }
    })

    lastPeerHeartbeats = new Map()
  })

  // Replicates the heartbeat handler from core/src/service.ts
  function handleHeartbeat(id: string, position: { x: number; y: number; z: number }) {
    lastPeerHeartbeats.set(id, Date.now())
    engine.onPeerPositionsUpdate([{ id, position: [position.x, position.y, position.z] }])
  }

  // Replicates the disconnect handler from core/src/service.ts (with the fix)
  function handleDisconnect(id: string) {
    lastPeerHeartbeats.delete(id)
    engine.onPeerDisconnected(id)
  }

  // Replicates the heartbeat expiry loop from core/src/service.ts
  function expireHeartbeats(expiredBefore: number) {
    for (const [peerId, lastHeartbeat] of lastPeerHeartbeats) {
      if (lastHeartbeat < expiredBefore) {
        lastPeerHeartbeats.delete(peerId)
        engine.onPeerDisconnected(peerId)
      }
    }
  }

  describe('when a peer disconnects and the heartbeat entry is cleaned up', () => {
    beforeEach(async () => {
      handleHeartbeat('peer1', { x: 0, y: 0, z: 0 })
      await engine.flush()
    })

    it('should remove the heartbeat entry on disconnect', () => {
      expect(lastPeerHeartbeats.has('peer1')).toBe(true)

      handleDisconnect('peer1')

      expect(lastPeerHeartbeats.has('peer1')).toBe(false)
    })
  })

  describe('when a peer disconnects and reconnects quickly', () => {
    beforeEach(async () => {
      handleHeartbeat('peer1', { x: 0, y: 0, z: 0 })
      await engine.flush()

      // Peer disconnects
      handleDisconnect('peer1')

      // Peer reconnects and sends a heartbeat
      handleHeartbeat('peer1', { x: 10, y: 0, z: 10 })
      await engine.flush()
    })

    it('should have the peer in an island after reconnection', () => {
      expect(engine.getIslands()).toHaveLength(1)
      const peer = engine.getPeerData('peer1')
      expect(peer).toBeDefined()
      expect(peer!.islandId).toBeDefined()
    })

    it('should not disconnect the peer when old heartbeat would have expired', () => {
      // Simulate expiry check — since the disconnect handler deleted the old entry
      // and the new heartbeat created a fresh entry, this should NOT expire the peer
      const now = Date.now()
      expireHeartbeats(now - CHECK_HEARTBEAT_INTERVAL)

      // The peer's new heartbeat should still be valid
      expect(lastPeerHeartbeats.has('peer1')).toBe(true)
      expect(engine.getPeerData('peer1')).toBeDefined()
    })
  })

  describe('when a peer disconnects and reconnects without heartbeat cleanup (pre-fix behavior)', () => {
    // This test demonstrates why the fix is needed
    let lastPeerHeartbeatsNoCleanup: Map<string, number>

    beforeEach(async () => {
      lastPeerHeartbeatsNoCleanup = new Map()
    })

    // Pre-fix disconnect handler: does NOT clean up heartbeat entry
    function handleDisconnectBroken(id: string) {
      // Missing: lastPeerHeartbeatsNoCleanup.delete(id)
      engine.onPeerDisconnected(id)
    }

    function handleHeartbeatNoCleanup(id: string, position: { x: number; y: number; z: number }) {
      lastPeerHeartbeatsNoCleanup.set(id, Date.now())
      engine.onPeerPositionsUpdate([{ id, position: [position.x, position.y, position.z] }])
    }

    it('should leave a stale heartbeat entry after disconnect', () => {
      handleHeartbeatNoCleanup('peer1', { x: 0, y: 0, z: 0 })
      handleDisconnectBroken('peer1')

      expect(lastPeerHeartbeatsNoCleanup.has('peer1')).toBe(true)
    })
  })

  describe('when heartbeat expiry runs and the peer has not sent heartbeats', () => {
    beforeEach(async () => {
      handleHeartbeat('peer1', { x: 0, y: 0, z: 0 })
      await engine.flush()
    })

    it('should disconnect the peer when heartbeat expires', () => {
      expect(engine.getPeerData('peer1')).toBeDefined()

      // Simulate enough time passing
      const farFuture = Date.now() + CHECK_HEARTBEAT_INTERVAL + 1000
      expireHeartbeats(farFuture)

      expect(lastPeerHeartbeats.has('peer1')).toBe(false)
      expect(engine.getPeerData('peer1')).toBeUndefined()
    })
  })

  describe('when heartbeat expiry runs and the peer is still active', () => {
    beforeEach(async () => {
      handleHeartbeat('peer1', { x: 0, y: 0, z: 0 })
      await engine.flush()
    })

    it('should not disconnect the peer if the heartbeat is recent', () => {
      const recentExpiry = Date.now() - CHECK_HEARTBEAT_INTERVAL
      expireHeartbeats(recentExpiry)

      expect(lastPeerHeartbeats.has('peer1')).toBe(true)
      expect(engine.getPeerData('peer1')).toBeDefined()
    })
  })
})
