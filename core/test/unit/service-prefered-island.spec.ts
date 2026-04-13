import { Engine, PeerPositionChange } from '../../src/types'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createArchipelagoEngine } from '../../src/adapters/engine'

/**
 * These tests verify the preferedIslandId handling, specifically the
 * interaction between the 'preferedIslandId' in change semantics and
 * how the core service maps desiredRoom to preferedIslandId.
 */
describe('preferedIslandId handling', () => {
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

  describe('when preferedIslandId key is present with undefined value', () => {
    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0], preferedIslandId: 'target-island' }
      ])
      await engine.flush()

      // This simulates what happened BEFORE the fix in service.ts:
      // the heartbeat handler always included the key, even when desiredRoom was undefined
      engine.onPeerPositionsUpdate([
        { id: '1', position: [5, 0, 5], preferedIslandId: undefined }
      ])
      await engine.flush()
    })

    it('should clear the preferedIslandId because the key is present', () => {
      const peer = engine.getPeerData('1')
      expect(peer!.preferedIslandId).toBeUndefined()
    })
  })

  describe('when preferedIslandId key is omitted entirely', () => {
    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: '1', position: [0, 0, 0], preferedIslandId: 'target-island' }
      ])
      await engine.flush()

      // This simulates the FIXED service.ts behavior:
      // when desiredRoom is undefined, the key is omitted from the change object
      engine.onPeerPositionsUpdate([{ id: '1', position: [5, 0, 5] }])
      await engine.flush()
    })

    it('should preserve the existing preferedIslandId', () => {
      const peer = engine.getPeerData('1')
      expect(peer!.preferedIslandId).toBe('target-island')
    })
  })

  describe('when simulating the core service heartbeat handler (fixed behavior)', () => {
    beforeEach(async () => {
      engine.onPeerPositionsUpdate([
        { id: 'peer1', position: [0, 0, 0], preferedIslandId: 'my-room' }
      ])
      await engine.flush()
    })

    it('should preserve preference across heartbeats without desiredRoom', () => {
      // Simulate multiple heartbeats from the FIXED service handler:
      // when desiredRoom is undefined, the key is omitted
      for (let i = 0; i < 5; i++) {
        const change: PeerPositionChange = { id: 'peer1', position: [i, 0, i] }
        // Note: preferedIslandId key is NOT in the object
        engine.onPeerPositionsUpdate([change])
      }

      const peer = engine.getPeerData('peer1')
      expect(peer!.preferedIslandId).toBe('my-room')
    })

    it('should clear preference when a heartbeat explicitly sets a new desiredRoom', () => {
      engine.onPeerPositionsUpdate([
        { id: 'peer1', position: [5, 0, 5], preferedIslandId: 'other-room' }
      ])

      const peer = engine.getPeerData('peer1')
      expect(peer!.preferedIslandId).toBe('other-room')
    })
  })
})
