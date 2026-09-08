import {
  IslandStatusMessage,
  ServiceDiscoveryMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'

/**
 * Iteration 1 of the Archipelago => Pulse migration: Pulse publishes `engine.islands` and
 * `engine.discovery` in core's place. Cluster IDs read `C{n}` and `max_peers` is 0 because
 * clusters are uncapped. These pin that wire contract through real protobuf bytes.
 *
 * They lived in `stats/test/unit/pulse-topology.spec.ts` and moved here ahead of iteration 2
 * deleting the `stats` workspace: the feeds outlive their first consumer, and what Pulse puts on
 * the wire has to stay pinned somewhere that survives. Only the assertions that need nothing but
 * the generated codec came across; the ones that go through stats' `decodeIslandsReport`, its
 * `/islands` handler and its `/core-status` handler stayed behind, to be deleted with it.
 *
 * ws-connector consumes neither feed. It hosts these because it is the workspace that remains.
 */
describe('pulse-published topology', () => {
  /**
   * Frozen wire bytes, hand-checked against archipelago.proto field numbers. Encoding and
   * decoding with the same generated module only proves the build round-trips; these literals
   * pin the bytes, so a regeneration that renumbers a field fails here instead of silently
   * zeroing `currentTime` (permanently unhealthy `/core-status`) or dropping every island.
   *
   * `08 80f4a9d2f933` is protocol#453's guarantee on the wire: current_time as a uint64
   * varint, wide enough for epoch milliseconds.
   */
  const DISCOVERY_WIRE = Buffer.from('0a0570756c736512120880f4a9d2f933120761626331323334182a', 'hex')

  /** Note the absence of field 3 (max_peers): proto3 omits zero, which is what Pulse sends. */
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
      const decoded = IslandStatusMessage.decode(ISLANDS_WIRE)

      expect(decoded.data).toEqual([
        {
          id: 'C1',
          peers: ['0x0001', '0x0002'],
          maxPeers: 0,
          center: { x: 10, y: 0, z: 20 },
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

    // The other direction of the same pin: a renumbered field or a `maxPeers` that stopped being
    // omitted at zero changes these bytes, and decode alone would not notice.
    it('should re-encode the islands snapshot to the same bytes', () => {
      const encoded = IslandStatusMessage.encode(IslandStatusMessage.decode(ISLANDS_WIRE)).finish()

      expect(Buffer.from(encoded).toString('hex')).toEqual(ISLANDS_WIRE.toString('hex'))
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
      const { data } = IslandStatusMessage.decode(encoded)

      expect(data).toHaveLength(2)
      expect(data[0]).toEqual({
        id: 'C1',
        peers: ['0x0001', '0x0002'],
        maxPeers: 0,
        center: { x: 10, y: 0, z: 20 },
        radius: 15
      })
      expect(data[1].id).toEqual('C2')
      // Was 100 while core published this feed; clusters are uncapped, so it reads 0.
      expect(data[1].maxPeers).toEqual(0)
    })
  })
})
