import { createPeersRegistry, IPeersRegistryComponent } from '../../src/adapters/peers-registry'
import { InternalWebSocket } from '../../src/types'

const ALICE = '0xaaaa000000000000000000000000000000000001'
const BOB = '0xbbbb000000000000000000000000000000000002'

describe('peers registry adapter', () => {
  let registry: IPeersRegistryComponent

  function makeWs(label: string): InternalWebSocket {
    return { label } as unknown as InternalWebSocket
  }

  beforeEach(async () => {
    registry = await createPeersRegistry()
  })

  describe('when a peer connects', () => {
    let ws: InternalWebSocket

    beforeEach(() => {
      ws = makeWs('alice')
      registry.onPeerConnected(ALICE, ws)
    })

    it('should return its socket', () => {
      expect(registry.getPeerWs(ALICE)).toBe(ws)
    })

    it('should count it', () => {
      expect(registry.getPeerCount()).toBe(1)
    })

    it('should include it in the snapshot the ban sweep iterates', () => {
      expect(registry.snapshot()).toEqual([{ id: ALICE, ws }])
    })

    it('should not resolve a different casing, since lookups are exact', () => {
      // The island feed looks peers up by the address parsed off the NATS subject. If the two
      // sides ever disagree on casing the message is dropped with no error at all.
      expect(registry.getPeerWs(ALICE.toUpperCase())).toBeUndefined()
    })
  })

  describe('when a peer is not connected', () => {
    it('should return undefined', () => {
      expect(registry.getPeerWs(ALICE)).toBeUndefined()
    })

    it('should report an empty snapshot', () => {
      expect(registry.snapshot()).toEqual([])
    })
  })

  describe('when a peer disconnects', () => {
    let ws: InternalWebSocket

    beforeEach(() => {
      ws = makeWs('alice')
      registry.onPeerConnected(ALICE, ws)
      registry.onPeerDisconnected(ALICE, ws)
    })

    it('should remove it', () => {
      expect(registry.getPeerWs(ALICE)).toBeUndefined()
      expect(registry.getPeerCount()).toBe(0)
    })
  })

  describe('when the same identity reconnects and the old socket closes afterwards', () => {
    let oldWs: InternalWebSocket
    let newWs: InternalWebSocket

    beforeEach(() => {
      oldWs = makeWs('old')
      newWs = makeWs('new')
      registry.onPeerConnected(ALICE, oldWs)
      registry.onPeerConnected(ALICE, newWs)

      // The previous socket's close lands after the reconnect — the ordering the guard exists for.
      registry.onPeerDisconnected(ALICE, oldWs)
    })

    it('should keep the live socket rather than letting the stale close evict it', () => {
      expect(registry.getPeerWs(ALICE)).toBe(newWs)
    })

    it('should still list it in the snapshot, so the ban sweep can still see it', () => {
      expect(registry.snapshot()).toEqual([{ id: ALICE, ws: newWs }])
    })
  })

  describe('when several peers are connected', () => {
    beforeEach(() => {
      registry.onPeerConnected(ALICE, makeWs('alice'))
      registry.onPeerConnected(BOB, makeWs('bob'))
    })

    it('should count them all', () => {
      expect(registry.getPeerCount()).toBe(2)
    })

    it('should snapshot a detached copy, safe to iterate while the registry mutates', () => {
      const snapshot = registry.snapshot()
      registry.onPeerDisconnected(ALICE, registry.getPeerWs(ALICE)!)

      expect(snapshot).toHaveLength(2)
      expect(registry.getPeerCount()).toBe(1)
    })
  })
})
