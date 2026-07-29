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
  /**
   * Frozen wire bytes, hand-checked against archipelago.proto field numbers. Encoding and
   * decoding with the same generated module only proves the build round-trips; these literals
   * pin the actual bytes, so a regeneration that renumbers a field fails here instead of
   * silently zeroing `currentTime` (permanent `/core-status` unhealthy) or dropping every
   * island (`{ok: true, islands: []}`).
   *
   * ServiceDiscoveryMessage: 0a "pulse" = field 1 (server_name, len-delim);
   * 12 = field 2 (status, len-delim), containing 08 <varint> = field 1 (current_time, varint —
   * this is the byte that would differ if it were re-typed or renumbered),
   * 12 "abc1234" = field 2 (commit_hash), 18 2a = field 3 (user_count = 42).
   */
  const DISCOVERY_WIRE = Buffer.from('0a0570756c736512120880f4a9d2f933120761626331323334182a', 'hex')

  /**
   * IslandStatusMessage: 0a = field 1 (data, repeated len-delim), containing
   * 0a "C1" = field 1 (id), 12 … = field 2 (peers, repeated), 22 = field 4 (center) with
   * 0d/1d/29 = fields 1/2/3 as fixed32/fixed32/double, and no field 3 (max_peers) at all —
   * proto3 omits zero, which is exactly what Pulse sends for an uncapped cluster.
   */
  const ISLANDS_WIRE = Buffer.from(
    '0a290a02433112063078303030311206307830303032220a0d000020411d0000a041290000000000002e40',
    'hex'
  )

  describe('when decoding frozen wire bytes', () => {
    it('should read the discovery heartbeat Pulse actually sends', () => {
      const decoded = ServiceDiscoveryMessage.decode(DISCOVERY_WIRE)

      expect(decoded.serverName).toEqual('pulse')
      expect(decoded.status!.currentTime).toEqual(1785000000000)
      expect(decoded.status!.commitHash).toEqual('abc1234')
      expect(decoded.status!.userCount).toEqual(42)
    })

    it('should read an islands snapshot with an omitted zero maxPeers', () => {
      const report = decodeIslandsReport(ISLANDS_WIRE)

      expect(report).toEqual([
        {
          id: 'C1',
          peers: ['0x0001', '0x0002'],
          maxPeers: 0,
          center: [10, 0, 20],
          radius: 15
        }
      ])
    })

    it('should still agree with what this build encodes', () => {
      const encoded = ServiceDiscoveryMessage.encode({
        serverName: 'pulse',
        status: { currentTime: 1785000000000, commitHash: 'abc1234', userCount: 42 }
      }).finish()

      expect(Buffer.from(encoded).toString('hex')).toEqual(DISCOVERY_WIRE.toString('hex'))
    })
  })

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
