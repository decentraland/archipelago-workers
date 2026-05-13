import { createBanSweep } from '../../src/adapters/ban-sweep'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IPeersRegistryComponent } from '../../src/adapters/peers-registry'
import { IBanCheckerComponent } from '../../src/adapters/ban-checker'
import { InternalWebSocket } from '../../src/types'

describe('ban sweep', () => {
  let peersRegistry: jest.Mocked<IPeersRegistryComponent>
  let banChecker: jest.Mocked<IBanCheckerComponent>
  let sentMessages: Map<string, Uint8Array[]>
  let endedSockets: Set<string>

  beforeEach(() => {
    jest.useFakeTimers()
    sentMessages = new Map()
    endedSockets = new Set()
  })

  afterEach(async () => {
    jest.useRealTimers()
  })

  function makeWs(id: string): InternalWebSocket {
    sentMessages.set(id, [])
    return {
      send: jest.fn((data: Uint8Array) => {
        sentMessages.get(id)!.push(data)
        return 1
      }),
      end: jest.fn(() => {
        endedSockets.add(id)
      }),
      getUserData: jest.fn().mockReturnValue({})
    } as unknown as InternalWebSocket
  }

  async function buildSweep(connectedIds: string[], bannedIds: Set<string>, intervalMs = 100) {
    const wsById = new Map<string, InternalWebSocket>(connectedIds.map((id) => [id, makeWs(id)]))

    peersRegistry = {
      onPeerConnected: jest.fn(),
      onPeerDisconnected: jest.fn(),
      getPeerWs: jest.fn((id: string) => wsById.get(id)),
      getPeerCount: jest.fn(() => wsById.size),
      snapshot: jest.fn(() =>
        Array.from(wsById, ([id, ws]) => ({ id, ws }))
      )
    } as jest.Mocked<IPeersRegistryComponent>

    banChecker = {
      isBanned: jest.fn(async (address: string) => bannedIds.has(address))
    } as jest.Mocked<IBanCheckerComponent>

    const config = createConfigComponent({ BAN_SWEEP_INTERVAL_MS: String(intervalMs) })
    const logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })

    const sweep = await createBanSweep({ config, logs, peersRegistry, banChecker })
    return { sweep, wsById }
  }

  async function tickAndFlush(intervalMs = 100) {
    jest.advanceTimersByTime(intervalMs)
    // Let any queued microtasks (from inside the setInterval callback) complete.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  describe('when the registry is empty', () => {
    it('does not call banChecker.isBanned', async () => {
      const { sweep } = await buildSweep([], new Set())
      await sweep.start!({} as never)

      await tickAndFlush()

      expect(banChecker.isBanned).not.toHaveBeenCalled()
      await sweep.stop!()
    })
  })

  describe('when no connected peer is banned', () => {
    it('checks every peer but ends none of their sockets', async () => {
      const { sweep, wsById } = await buildSweep(['0xa', '0xb', '0xc'], new Set())
      await sweep.start!({} as never)

      await tickAndFlush()

      expect(banChecker.isBanned).toHaveBeenCalledTimes(3)
      for (const [, ws] of wsById) expect(ws.end).not.toHaveBeenCalled()
      expect(endedSockets.size).toBe(0)
      await sweep.stop!()
    })
  })

  describe('when one connected peer is banned', () => {
    it('sends a kicked message and ends only that ws', async () => {
      const { sweep, wsById } = await buildSweep(['0xa', '0xbanned', '0xc'], new Set(['0xbanned']))
      await sweep.start!({} as never)

      await tickAndFlush()

      expect(sentMessages.get('0xbanned')).toHaveLength(1)
      expect(wsById.get('0xbanned')!.end).toHaveBeenCalledTimes(1)
      expect(sentMessages.get('0xa')).toHaveLength(0)
      expect(sentMessages.get('0xc')).toHaveLength(0)
      expect(wsById.get('0xa')!.end).not.toHaveBeenCalled()
      expect(wsById.get('0xc')!.end).not.toHaveBeenCalled()
      await sweep.stop!()
    })
  })

  describe('when stop is called', () => {
    it('clears the interval so no further sweeps run', async () => {
      const { sweep } = await buildSweep(['0xa'], new Set(['0xa']))
      await sweep.start!({} as never)
      await tickAndFlush()
      const callsBefore = (banChecker.isBanned as jest.Mock).mock.calls.length

      await sweep.stop!()
      await tickAndFlush()
      await tickAndFlush()

      expect((banChecker.isBanned as jest.Mock).mock.calls.length).toBe(callsBefore)
    })
  })
})
