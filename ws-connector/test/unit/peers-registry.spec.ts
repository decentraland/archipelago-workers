import { createPeersRegistry, IPeersRegistryComponent } from '../../src/adapters/peers-registry'
import { InternalWebSocket } from '../../src/types'

const ALICE = '0xaaaa000000000000000000000000000000000001'
const BOB = '0xbbbb000000000000000000000000000000000002'
const DESKTOP = '0xd000000000000000000000000000000000000001'
const LAPTOP = '0xd000000000000000000000000000000000000002'

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
      ws = makeWs('alice-desktop')
      registry.onPeerConnected(ALICE, DESKTOP, ws)
    })

    it('should return its socket for its session', () => {
      expect(registry.getPeerWs(ALICE, DESKTOP)).toBe(ws)
    })

    it('should not return it for another session', () => {
      expect(registry.getPeerWs(ALICE, LAPTOP)).toBeUndefined()
    })

    it('should report the wallet as connected', () => {
      expect(registry.hasPeer(ALICE)).toBe(true)
    })

    it('should count it', () => {
      expect(registry.getPeerCount()).toBe(1)
    })

    it('should include it in the snapshot the ban sweep iterates', () => {
      expect(registry.snapshot()).toEqual([{ id: ALICE, session: DESKTOP, ws }])
    })

    it('should not resolve a different casing, since lookups are exact', () => {
      expect(registry.getPeerWs(ALICE.toUpperCase(), DESKTOP)).toBeUndefined()
      expect(registry.getPeerWs(ALICE, DESKTOP.toUpperCase())).toBeUndefined()
    })
  })

  describe('when a peer is not connected', () => {
    it('should return undefined', () => {
      expect(registry.getPeerWs(ALICE, DESKTOP)).toBeUndefined()
      expect(registry.getNewestPeerWs(ALICE)).toBeUndefined()
      expect(registry.hasPeer(ALICE)).toBe(false)
    })

    it('should report an empty snapshot', () => {
      expect(registry.snapshot()).toEqual([])
    })
  })

  describe('when the same wallet connects from a second device', () => {
    let desktop: InternalWebSocket
    let laptop: InternalWebSocket

    beforeEach(() => {
      desktop = makeWs('desktop')
      laptop = makeWs('laptop')
      registry.onPeerConnected(ALICE, DESKTOP, desktop)
      registry.onPeerConnected(ALICE, LAPTOP, laptop)
    })

    it('should hold both sockets, each under its own session', () => {
      expect(registry.getPeerWs(ALICE, DESKTOP)).toBe(desktop)
      expect(registry.getPeerWs(ALICE, LAPTOP)).toBe(laptop)
      expect(registry.getPeerCount()).toBe(2)
    })

    it('should name the most recently connected one as newest, for the legacy subject', () => {
      expect(registry.getNewestPeerWs(ALICE)).toBe(laptop)
    })

    it('should keep the other session when one disconnects', () => {
      registry.onPeerDisconnected(ALICE, LAPTOP, laptop)

      expect(registry.getPeerWs(ALICE, DESKTOP)).toBe(desktop)
      expect(registry.getNewestPeerWs(ALICE)).toBe(desktop)
      expect(registry.hasPeer(ALICE)).toBe(true)
    })
  })

  describe('when the same session reconnects and the old socket closes afterwards', () => {
    let oldWs: InternalWebSocket
    let newWs: InternalWebSocket

    beforeEach(() => {
      oldWs = makeWs('old')
      newWs = makeWs('new')
      registry.onPeerConnected(ALICE, DESKTOP, oldWs)
      registry.onPeerConnected(ALICE, DESKTOP, newWs)

      // The previous socket's close lands after the reconnect — the ordering the guard exists for.
      registry.onPeerDisconnected(ALICE, DESKTOP, oldWs)
    })

    it('should keep the live socket rather than letting the stale close evict it', () => {
      expect(registry.getPeerWs(ALICE, DESKTOP)).toBe(newWs)
    })

    it('should count one socket for the session', () => {
      expect(registry.getPeerCount()).toBe(1)
    })

    it('should treat the replaced socket as newest again, even if an older session was connected later', () => {
      const laptop = makeWs('laptop')
      const newerDesktop = makeWs('newer-desktop')
      registry.onPeerConnected(ALICE, LAPTOP, laptop)
      registry.onPeerConnected(ALICE, DESKTOP, newerDesktop)

      expect(registry.getNewestPeerWs(ALICE)).toBe(newerDesktop)
    })
  })

  describe('when the last session of a wallet disconnects', () => {
    beforeEach(() => {
      const ws = makeWs('alice')
      registry.onPeerConnected(ALICE, DESKTOP, ws)
      registry.onPeerDisconnected(ALICE, DESKTOP, ws)
    })

    it('should forget the wallet entirely', () => {
      expect(registry.hasPeer(ALICE)).toBe(false)
      expect(registry.getPeerCount()).toBe(0)
      expect(registry.snapshot()).toEqual([])
    })
  })

  describe('when several peers are connected', () => {
    beforeEach(() => {
      registry.onPeerConnected(ALICE, DESKTOP, makeWs('alice'))
      registry.onPeerConnected(BOB, DESKTOP, makeWs('bob'))
    })

    it('should count them all', () => {
      expect(registry.getPeerCount()).toBe(2)
    })

    it('should snapshot a detached copy, safe to iterate while the registry mutates', () => {
      const snapshot = registry.snapshot()
      registry.onPeerDisconnected(ALICE, DESKTOP, registry.getPeerWs(ALICE, DESKTOP)!)

      expect(snapshot).toHaveLength(2)
      expect(registry.getPeerCount()).toBe(1)
    })
  })
})
