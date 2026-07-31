import {
  Heartbeat,
  IslandStatusMessage,
  ServiceDiscoveryMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { INatsComponent, Subscription } from '@well-known-components/nats-component/dist/types'
import { createLogComponent } from '@well-known-components/logger'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { registerSubscriptions } from '../../src/logic/subscriptions'
import { createStatsComponent } from '../../src/adapters/stats'
import { createCoreStatusComponent } from '../../src/adapters/core-status'

type Handler = (err: Error | null, message: any) => void

/**
 * The NATS component invokes these callbacks unguarded, so a throw escaping one unwinds into
 * the client's reader loop and stops delivery on *every* subject — not just the one that
 * received the bad frame. Since iteration 1 of the Archipelago => Pulse migration the
 * publishers of engine.islands and engine.discovery are outside this repo, so a malformed or
 * renumbered frame is a live possibility rather than a hypothetical.
 */
describe('nats subscriptions', () => {
  // Field 1, varint wire type, with no payload: every message type throws "index out of range".
  const MALFORMED = new Uint8Array([0x08])

  async function setup() {
    const handlers = new Map<string, Handler>()
    const nats = {
      subscribe: (subject: string, cb: Handler) => {
        handlers.set(subject, cb)
        return {} as Subscription
      },
      publish: jest.fn()
    } as unknown as INatsComponent
    const config = createConfigComponent({ LOG_LEVEL: 'ERROR' })
    const logs = await createLogComponent({ config })
    const stats = createStatsComponent()
    const clock = { now: () => 1785000000000 }
    const coreStatus = createCoreStatusComponent({ clock })

    registerSubscriptions({ nats, logs, stats, coreStatus })

    return { handlers, stats, coreStatus }
  }

  function deliver(handlers: Map<string, Handler>, subject: string, data: Uint8Array, natsSubject = subject) {
    const handler = handlers.get(subject)
    if (!handler) {
      throw new Error(`no handler registered for ${subject}`)
    }
    handler(null, { subject: natsSubject, data })
  }

  it('should subscribe to exactly the four subjects stats consumes', async () => {
    const { handlers } = await setup()

    expect([...handlers.keys()]).toEqual([
      'peer.*.disconnect',
      'peer.*.heartbeat',
      'engine.islands',
      'engine.discovery'
    ])
  })

  describe('when a frame is malformed', () => {
    it('should not let a heartbeat throw escape the handler', async () => {
      const { handlers, stats } = await setup()

      expect(() => Heartbeat.decode(MALFORMED)).toThrow()
      expect(() => deliver(handlers, 'peer.*.heartbeat', MALFORMED, 'peer.0x0001.heartbeat')).not.toThrow()
      expect(stats.getPeers().size).toEqual(0)
    })

    it('should not let an islands throw escape the handler', async () => {
      const { handlers, stats } = await setup()

      expect(() => IslandStatusMessage.decode(MALFORMED)).toThrow()
      expect(() => deliver(handlers, 'engine.islands', MALFORMED)).not.toThrow()
      expect(stats.getIslands()).toEqual([])
    })

    it('should not let a discovery throw escape the handler', async () => {
      const { handlers, coreStatus } = await setup()

      expect(() => ServiceDiscoveryMessage.decode(MALFORMED)).toThrow()
      expect(() => deliver(handlers, 'engine.discovery', MALFORMED)).not.toThrow()
      expect(coreStatus.isHealthy()).toEqual(false)
    })
  })

  describe('when the subscription itself errors', () => {
    it('should not throw for any subject', async () => {
      const { handlers } = await setup()

      for (const [subject, handler] of handlers) {
        expect(() => handler(new Error(`subscription failed for ${subject}`), undefined)).not.toThrow()
      }
    })
  })

  describe('when frames are well formed', () => {
    it('should update the peer map from a heartbeat', async () => {
      const { handlers, stats } = await setup()
      const data = Heartbeat.encode({ position: { x: 1, y: 2, z: 3 }, desiredRoom: undefined }).finish()

      deliver(handlers, 'peer.*.heartbeat', data, 'peer.0x0001.heartbeat')

      expect(stats.getPeers().get('0x0001')).toMatchObject({ address: '0x0001', x: 1, y: 2, z: 3 })
    })

    it('should drop a peer on disconnect', async () => {
      const { handlers, stats } = await setup()
      const data = Heartbeat.encode({ position: { x: 1, y: 2, z: 3 }, desiredRoom: undefined }).finish()
      deliver(handlers, 'peer.*.heartbeat', data, 'peer.0x0001.heartbeat')

      deliver(handlers, 'peer.*.disconnect', new Uint8Array(), 'peer.0x0001.disconnect')

      expect(stats.getPeers().size).toEqual(0)
    })

    it('should store the topology from an islands snapshot', async () => {
      const { handlers, stats } = await setup()
      const data = IslandStatusMessage.encode({
        data: [{ id: 'C1', peers: ['0x0001'], maxPeers: 0, center: { x: 0, y: 0, z: 0 }, radius: 1 }]
      }).finish()

      deliver(handlers, 'engine.islands', data)

      expect(stats.getIslands().map((island) => island.id)).toEqual(['C1'])
    })

    it('should mark the publisher healthy from a discovery heartbeat', async () => {
      const { handlers, coreStatus } = await setup()
      const data = ServiceDiscoveryMessage.encode({
        serverName: 'pulse',
        status: { currentTime: 1785000000000, commitHash: 'abc1234', userCount: 42 }
      }).finish()

      deliver(handlers, 'engine.discovery', data)

      expect(coreStatus.isHealthy()).toEqual(true)
      expect(coreStatus.getUserCount()).toEqual(42)
    })
  })
})
