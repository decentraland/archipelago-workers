import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@dcl/metrics'
import { metricDeclarations } from '../../src/metrics'
import { ILoggerComponent } from '@well-known-components/interfaces'
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

type StubWebSocket = InternalWebSocket & { send: jest.Mock; end: jest.Mock }

/**
 * Fans a publish out to every matching subscription, which is what an un-grouped NATS
 * subscription does and what the single-replica spec cannot express. Delivery is synchronous, so
 * a handler that publishes re-enters immediately — a supersede loop would recurse here rather
 * than merely being argued about.
 */
function createBroker({ deferred = false } = {}) {
  const subscriptions: { pattern: string; callback: SubscriptionCallback }[] = []
  const queue: { subject: string; data: Uint8Array }[] = []

  function matches(pattern: string, subject: string): boolean {
    const expected = pattern.split('.')
    const actual = subject.split('.')

    return expected.length === actual.length && expected.every((part, i) => part === '*' || part === actual[i])
  }

  function deliver(subject: string, data: Uint8Array): void {
    for (const { pattern, callback } of [...subscriptions]) {
      if (matches(pattern, subject)) {
        callback(null, { subject, data })
      }
    }
  }

  return {
    /** Delivers anything queued, including what the handlers publish while draining. */
    drain(): void {
      while (queue.length > 0) {
        const message = queue.shift()!
        deliver(message.subject, message.data)
      }
    },
    publish: jest.fn((subject: string, data?: Uint8Array) => {
      const message = { subject, data: data ?? new Uint8Array() }
      if (deferred) {
        queue.push(message)
        return
      }

      deliver(message.subject, message.data)
    }),
    subscribe: jest.fn((pattern: string, callback: SubscriptionCallback) => {
      subscriptions.push({ pattern, callback })
      return { unsubscribe: jest.fn() }
    })
  }
}

describe('supersede across replicas', () => {
  let logs: ILoggerComponent
  let nats: ReturnType<typeof createBroker>

  /** uWS documents `end` as immediately calling the close handler, which is what this does. */
  function makeWs(sessionId: string, peersRegistry: ReturnType<typeof createPeersRegistryMockedComponent>) {
    const data = { stage: Stage.HANDSHAKE_COMPLETED, address: ADDRESS, sessionId } as WsUserData
    const ws = {
      getUserData: () => data,
      send: jest.fn().mockReturnValue(1),
      end: jest.fn(() => {
        data.isClosed = true
        peersRegistry.onPeerDisconnected(ADDRESS, ws as unknown as InternalWebSocket)
      })
    }

    return ws as unknown as StubWebSocket
  }

  function createReplica() {
    const peersRegistry = createPeersRegistryMockedComponent()
    const supersedeCooldown = createSupersedeCooldownMockedComponent()
    registerSupersedeSubscriptions({
      logs,
      metrics: createTestMetricsComponent(metricDeclarations),
      nats: nats as never,
      peersRegistry,
      supersedeCooldown
    })

    /** Stands in for a completed handshake on this replica: register, then announce. */
    function welcome(sessionId: string): StubWebSocket {
      const ws = makeWs(sessionId, peersRegistry)
      peersRegistry.onPeerConnected(ADDRESS, ws)
      nats.publish(`peer.${ADDRESS}.connect`, Buffer.from(sessionId, 'utf8'))
      return ws
    }

    return { peersRegistry, supersedeCooldown, welcome }
  }

  beforeEach(async () => {
    logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })
    nats = createBroker()
  })

  describe('when the two sessions of one wallet land on different replicas', () => {
    let first: ReturnType<typeof createReplica>
    let second: ReturnType<typeof createReplica>
    let bystander: ReturnType<typeof createReplica>
    let a: StubWebSocket
    let b: StubWebSocket

    beforeEach(() => {
      first = createReplica()
      second = createReplica()
      bystander = createReplica()

      a = first.welcome(sessionAt(1))
      nats.publish.mockClear()
      b = second.welcome(sessionAt(2))
    })

    it('should kick the older session, which its own replica never saw start', () => {
      expect(a.end).toHaveBeenCalled()
    })

    it('should leave the newer session connected', () => {
      expect(b.end).not.toHaveBeenCalled()
      expect(second.peersRegistry.getPeerWs(ADDRESS)).toBe(b)
    })

    it('should arm the cooldown on every replica, including one holding no socket at all', () => {
      for (const replica of [first, second, bystander]) {
        expect(replica.supersedeCooldown.onSuperseded).toHaveBeenCalledWith(ADDRESS)
      }
    })

    it('should announce the supersede exactly once, however many replicas are listening', () => {
      expect(nats.publish.mock.calls.filter(([subject]) => subject === `peer.${ADDRESS}.superseded`)).toHaveLength(1)
    })
  })

  describe('when two sessions are welcomed inside one broker hop', () => {
    let first: ReturnType<typeof createReplica>
    let second: ReturnType<typeof createReplica>
    let a: StubWebSocket
    let b: StubWebSocket

    beforeEach(() => {
      nats = createBroker({ deferred: true })
      first = createReplica()
      second = createReplica()

      // Neither announcement has been delivered when the other session is welcomed, which is
      // every wallet that opens two sessions at once.
      a = first.welcome(sessionAt(1))
      b = second.welcome(sessionAt(2))
      nats.drain()
    })

    it('should leave exactly one session standing rather than killing both', () => {
      expect([a, b].filter((ws) => ws.end.mock.calls.length === 0)).toHaveLength(1)
    })

    it('should keep the wallet reachable on the replica that still holds it', () => {
      const held = [first, second].map((replica) => replica.peersRegistry.getPeerWs(ADDRESS)).filter(Boolean)

      expect(held).toHaveLength(1)
    })
  })

  describe('when a wallet connects for the first time', () => {
    let first: ReturnType<typeof createReplica>
    let second: ReturnType<typeof createReplica>
    let a: StubWebSocket

    beforeEach(() => {
      first = createReplica()
      second = createReplica()
      a = first.welcome(sessionAt(1))
    })

    it('should not kick the socket that just announced itself', () => {
      expect(a.end).not.toHaveBeenCalled()
    })

    it('should arm nothing, since an ordinary connect must not penalise its own reconnect', () => {
      expect(first.supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
      expect(second.supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
    })
  })

  describe('when three sessions of one wallet arrive in turn, each on its own replica', () => {
    let replicas: ReturnType<typeof createReplica>[]
    let sockets: StubWebSocket[]

    beforeEach(() => {
      replicas = [createReplica(), createReplica(), createReplica()]
      sockets = replicas.map((replica, i) => replica.welcome(sessionAt(i + 1)))
    })

    it('should leave exactly one session standing, the newest', () => {
      expect(sockets.filter((ws) => !ws.end.mock.calls.length)).toEqual([sockets[2]])
    })

    it('should settle rather than have each supersede provoke the next', () => {
      // One per session that displaced a predecessor; a feedback loop would blow the stack
      // first, since this broker delivers synchronously.
      expect(nats.publish.mock.calls.filter(([subject]) => subject.endsWith('.superseded'))).toHaveLength(2)
    })
  })
})
