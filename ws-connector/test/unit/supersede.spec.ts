import { ServerPacket, KickedReason } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@dcl/metrics'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations } from '../../src/metrics'
import { SubscriptionCallback } from '@well-known-components/nats-component/dist/types'
import { registerSupersedeSubscriptions } from '../../src/logic/supersede'
import { InternalWebSocket, Stage, WsUserData } from '../../src/types'
import { createPeersRegistryMockedComponent } from '../mocks/peers-registry-mock'
import { createSupersedeCooldownMockedComponent } from '../mocks/supersede-cooldown-mock'

const ADDRESS = '0x000000000000000000000000000000000000abcd'
/** Mirrors the production shape: a fixed-width ordering prefix and a random tail. */
function sessionAt(order: number): string {
  return `${order.toString(16).padStart(12, '0')}00112233445566aa`
}

const HELD_SESSION = sessionAt(2)
const NEWER_SESSION = sessionAt(3)
const OLDER_SESSION = sessionAt(1)

type StubWebSocket = InternalWebSocket & { send: jest.Mock; end: jest.Mock }

describe('supersede subscriptions', () => {
  let peersRegistry: ReturnType<typeof createPeersRegistryMockedComponent>
  let supersedeCooldown: ReturnType<typeof createSupersedeCooldownMockedComponent>
  let nats: { publish: jest.Mock; subscribe: jest.Mock }
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>
  let subscriptions: Map<string, SubscriptionCallback>

  function makeWs(overrides: Partial<WsUserData> = {}): StubWebSocket {
    const data = { stage: Stage.HANDSHAKE_COMPLETED, address: ADDRESS, ...overrides } as WsUserData

    return {
      getUserData: () => data,
      send: jest.fn().mockReturnValue(1),
      end: jest.fn()
    } as unknown as StubWebSocket
  }

  function deliver(topic: string, subject: string, payload = ''): void {
    subscriptions.get(topic)!(null, { subject, data: Buffer.from(payload, 'utf8') })
  }

  function published(subject: string): unknown[][] {
    return nats.publish.mock.calls.filter(([target]) => target === subject)
  }

  beforeEach(async () => {
    peersRegistry = createPeersRegistryMockedComponent()
    supersedeCooldown = createSupersedeCooldownMockedComponent()
    subscriptions = new Map()
    metrics = createTestMetricsComponent(metricDeclarations)
    jest.spyOn(metrics, 'increment')
    nats = {
      publish: jest.fn(),
      subscribe: jest.fn((topic: string, callback: SubscriptionCallback) => {
        subscriptions.set(topic, callback)
        return { unsubscribe: jest.fn() }
      })
    }

    registerSupersedeSubscriptions({
      logs: await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) }),
      metrics,
      nats: nats as never,
      peersRegistry,
      supersedeCooldown
    })
  })

  it('should listen for both session events, since only the holder can act on either', () => {
    expect(nats.subscribe).toHaveBeenCalledTimes(2)
    expect([...subscriptions.keys()]).toEqual(['peer.*.connect', 'peer.*.superseded'])
  })

  describe('when a session starts elsewhere for an address this replica holds', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({ sessionId: HELD_SESSION })
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`, NEWER_SESSION)
    })

    it('should kick the socket it holds', () => {
      expect(held.end).toHaveBeenCalled()
    })

    it('should tell that client why before closing on it', () => {
      const packet = ServerPacket.decode(held.send.mock.calls[0][0] as Uint8Array)

      expect(packet.message).toEqual({ $case: 'kicked', kicked: { reason: KickedReason.KR_NEW_SESSION } })
    })

    it('should arm the cooldown here without waiting for its own announcement to come back', () => {
      expect(supersedeCooldown.onSuperseded).toHaveBeenCalledWith(ADDRESS)
    })

    it('should announce the supersede so the remaining replicas arm too', () => {
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(1)
    })

    it('should count the kick, since this path is invisible on a single-replica deployment', () => {
      expect(metrics.increment).toHaveBeenCalledWith('dcl_ws_connector_supersede_kicks_total')
    })
  })

  describe('when the announcement names the session this replica holds', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({ sessionId: HELD_SESSION })
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`, HELD_SESSION)
    })

    it('should leave it alone, since a publisher hears its own announcement', () => {
      expect(held.send).not.toHaveBeenCalled()
      expect(held.end).not.toHaveBeenCalled()
      expect(supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(0)
    })
  })

  describe('when the announcement names an older session than the one held', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({ sessionId: HELD_SESSION })
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`, OLDER_SESSION)
    })

    it('should keep the newer session, since the announcement merely crossed it on the wire', () => {
      expect(held.end).not.toHaveBeenCalled()
      expect(supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(0)
    })
  })

  describe('when this replica holds nothing for the address', () => {
    beforeEach(() => {
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`, NEWER_SESSION)
    })

    it('should do nothing, leaving the announcement to whichever replica holds it', () => {
      expect(supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(0)
    })
  })

  describe('when the socket it holds has already closed', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({ sessionId: HELD_SESSION, isClosed: true })
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`, NEWER_SESSION)
    })

    it('should not supersede a session that is already gone', () => {
      expect(held.end).not.toHaveBeenCalled()
      expect(supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(0)
    })
  })

  describe('when the socket it holds has no session id', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({})
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`, NEWER_SESSION)
    })

    it('should leave it alone, since nothing can be ordered against it', () => {
      expect(held.end).not.toHaveBeenCalled()
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(0)
    })
  })

  describe('when the announcement carries no session id', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({ sessionId: HELD_SESSION })
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS}.connect`)
    })

    it('should leave the socket alone, since a build without session ids cannot win', () => {
      expect(held.end).not.toHaveBeenCalled()
      expect(published(`peer.${ADDRESS}.superseded`)).toHaveLength(0)
    })
  })

  describe('when the subject carries a checksummed address', () => {
    let held: StubWebSocket

    beforeEach(() => {
      held = makeWs({ sessionId: HELD_SESSION })
      peersRegistry.onPeerConnected(ADDRESS, held)
      deliver('peer.*.connect', `peer.${ADDRESS.toUpperCase()}.connect`, NEWER_SESSION)
    })

    it('should still find the socket, which is registered lower-cased', () => {
      expect(held.end).toHaveBeenCalled()
    })
  })

  describe('when another replica announces a supersede', () => {
    beforeEach(() => {
      deliver('peer.*.superseded', `peer.${ADDRESS}.superseded`)
    })

    it('should arm the cooldown here too, so the kicked client is refused wherever it lands', () => {
      expect(supersedeCooldown.onSuperseded).toHaveBeenCalledWith(ADDRESS)
    })
  })
})
