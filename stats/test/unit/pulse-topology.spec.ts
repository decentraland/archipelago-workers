import {
  IslandStatusMessage,
  ServiceDiscoveryMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { decodeIslandsReport } from '../../src/logic/decode'
import { createStatsComponent } from '../../src/adapters/stats'
import { createCoreStatusComponent } from '../../src/adapters/core-status'
import { islandsHandler } from '../../src/controllers/handlers/islands-handler'
import { coreStatusHandler } from '../../src/controllers/handlers/core-status-handler'

/**
 * Iteration 1 of the Archipelago => Pulse migration: Pulse publishes engine.islands and
 * engine.discovery in core's place. Cluster IDs read C{n} and max_peers is 0 because
 * clusters are uncapped. These tests pin that wire contract through real protobuf bytes.
 */
describe('pulse-published topology', () => {
  describe('when decoding an engine.islands snapshot published by Pulse', () => {
    const encoded = IslandStatusMessage.encode({
      data: [
        {
          id: 'C1',
          peers: ['0x0001', '0x0002'],
          maxPeers: 0,
          center: { x: 10, y: 0, z: 20 },
          radius: 15
        },
        {
          id: 'C2',
          peers: ['0x0003'],
          maxPeers: 0,
          center: { x: -100, y: 0, z: 50 },
          radius: 0
        }
      ]
    }).finish()

    it('should preserve the C{n} ids and the uncapped maxPeers', () => {
      const report = decodeIslandsReport(encoded)

      expect(report).toHaveLength(2)
      expect(report[0]).toEqual({
        id: 'C1',
        peers: ['0x0001', '0x0002'],
        maxPeers: 0,
        center: [10, 0, 20],
        radius: 15
      })
      expect(report[1].id).toEqual('C2')
      expect(report[1].maxPeers).toEqual(0)
    })

    it('should serve the pulse topology through GET /islands', async () => {
      const stats = createStatsComponent()
      stats.onIslandsDataReceived(decodeIslandsReport(encoded))
      stats.onPeerUpdated('0x0001', { address: '0x0001', time: Date.now(), x: 10, y: 0, z: 20 })

      const { body } = await islandsHandler({
        url: new URL('https://localhost/islands'),
        components: { stats }
      })

      expect(body.ok).toEqual(true)
      expect(body.islands.map((island) => island.id)).toEqual(['C1', 'C2'])
      // Was 100 while core published this feed; clusters are uncapped, so it reads 0.
      expect(body.islands.every((island) => island.maxPeers === 0)).toEqual(true)
      expect(body.islands[0].peers.map((peer) => peer.address)).toEqual(['0x0001'])
    })
  })

  describe('when an island snapshot carries no center', () => {
    it('should skip it rather than serving a broken island', () => {
      const encoded = IslandStatusMessage.encode({
        data: [{ id: 'C1', peers: ['0x0001'], maxPeers: 0, radius: 0, center: undefined }]
      }).finish()

      expect(decodeIslandsReport(encoded)).toEqual([])
    })
  })

  describe('when decoding an engine.discovery heartbeat published by Pulse', () => {
    // Regression guard for protocol#453: ServiceStatus.current_time must be uint64.
    // Epoch milliseconds overflow uint32, and /core-status health is
    // `now - currentTime < 90s`, so a truncated timestamp reads permanently unhealthy.
    const currentTime = 1785000000000

    it('should round-trip epoch-millisecond timestamps without truncation', () => {
      const encoded = ServiceDiscoveryMessage.encode({
        serverName: 'pulse',
        status: { currentTime, commitHash: 'abc1234', userCount: 42 }
      }).finish()

      const decoded = ServiceDiscoveryMessage.decode(encoded)

      expect(decoded.status!.currentTime).toEqual(currentTime)
      expect(decoded.serverName).toEqual('pulse')
    })

    it('should read as healthy through GET /core-status', async () => {
      const encoded = ServiceDiscoveryMessage.encode({
        serverName: 'pulse',
        status: { currentTime, commitHash: 'abc1234', userCount: 42 }
      }).finish()
      const coreStatus = createCoreStatusComponent({ clock: { now: () => currentTime + 10000 } })
      coreStatus.onServiceDiscoveryReceived(ServiceDiscoveryMessage.decode(encoded))

      const { body } = await coreStatusHandler({
        url: new URL('https://localhost/core-status'),
        components: { coreStatus }
      })

      expect(body).toEqual({ healthy: true, userCount: 42 })
    })
  })
})
