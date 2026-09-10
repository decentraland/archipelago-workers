import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { createBanSweep } from '../../src/adapters/ban-sweep'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IPeersRegistryComponent } from '../../src/adapters/peers-registry'
import { IBanCheckerComponent } from '../../src/adapters/ban-checker'
import { InternalWebSocket } from '../../src/types'

const SESSION = '0xd000000000000000000000000000000000000001'

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
      getPeerWs: jest.fn((id: string, _session: string) => wsById.get(id)),
      getNewestPeerWs: jest.fn((id: string) => wsById.get(id)),
      hasPeer: jest.fn((id: string) => wsById.has(id)),
      getPeerCount: jest.fn(() => wsById.size),
      snapshot: jest.fn(() => Array.from(wsById, ([id, ws]) => ({ id, session: SESSION, ws })))
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
    it('should not call banChecker.isBanned', async () => {
      const { sweep } = await buildSweep([], new Set())
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(banChecker.isBanned).not.toHaveBeenCalled()
      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when no connected peer is banned', () => {
    it('should check every peer but end none of their sockets', async () => {
      const { sweep, wsById } = await buildSweep(['0xa', '0xb', '0xc'], new Set())
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(banChecker.isBanned).toHaveBeenCalledTimes(3)
      for (const [, ws] of wsById) expect(ws.end).not.toHaveBeenCalled()
      expect(endedSockets.size).toBe(0)
      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when one connected peer is banned', () => {
    it('should send a kicked message and end only that ws', async () => {
      const { sweep, wsById } = await buildSweep(['0xa', '0xbanned', '0xc'], new Set(['0xbanned']))
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(sentMessages.get('0xbanned')).toHaveLength(1)
      expect(wsById.get('0xbanned')!.end).toHaveBeenCalledTimes(1)
      expect(sentMessages.get('0xa')).toHaveLength(0)
      expect(sentMessages.get('0xc')).toHaveLength(0)
      expect(wsById.get('0xa')!.end).not.toHaveBeenCalled()
      expect(wsById.get('0xc')!.end).not.toHaveBeenCalled()
      await sweep[STOP_COMPONENT]!()
    })

    it('should look the banned socket up under its session', async () => {
      const { sweep } = await buildSweep(['0xa', '0xbanned', '0xc'], new Set(['0xbanned']))
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(peersRegistry.getPeerWs).toHaveBeenCalledWith('0xbanned', SESSION)
      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when a sweep is still running as the next interval fires', () => {
    it('should skip the overlapping tick rather than stack another concurrency budget', async () => {
      // setInterval does not await the async callback. Each sweep carries its own budget of
      // BAN_SWEEP_CONCURRENCY in-flight ban checks, so overlapping sweeps multiply load on
      // comms-gatekeeper — and a slow gatekeeper is exactly what makes a sweep outrun its
      // interval, so the pile-up compounds the problem that caused it.
      const { sweep } = await buildSweep(['0xa'], new Set())
      let release: () => void = () => {}
      ;(banChecker.isBanned as jest.Mock).mockImplementation(
        () => new Promise<boolean>((resolve) => (release = () => resolve(false)))
      )
      await sweep[START_COMPONENT]!({} as never)

      // advanceTimersByTimeAsync drains microtasks between timers, which the sync variant does
      // not — the guard is cleared in a `finally`, several microtask hops behind the resolve.
      // First tick starts a sweep that never completes...
      await jest.advanceTimersByTimeAsync(100)
      expect(banChecker.isBanned).toHaveBeenCalledTimes(1)

      // ...and two further ticks must not start their own.
      await jest.advanceTimersByTimeAsync(200)
      expect(banChecker.isBanned).toHaveBeenCalledTimes(1)

      // Once it finishes, the next tick sweeps again.
      release()
      await jest.advanceTimersByTimeAsync(100)
      expect(banChecker.isBanned).toHaveBeenCalledTimes(2)

      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when a banned peer disconnects between the snapshot and the ban check', () => {
    it('should skip it instead of acting on a socket that is already gone', async () => {
      const { sweep } = await buildSweep(['0xbanned'], new Set(['0xbanned']))
      // Present in the snapshot the sweep started from, absent by the time it looks the socket up.
      ;(peersRegistry.getPeerWs as jest.Mock).mockReturnValue(undefined)
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(sentMessages.get('0xbanned')).toHaveLength(0)
      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when a banned peer socket throws while being kicked', () => {
    // Every step is individually guarded so one bad socket cannot abort the whole sweep — which
    // would leave every peer after it in the list still connected while banned.
    it('should still close that socket after a failing send', async () => {
      const { sweep, wsById } = await buildSweep(['0xbanned'], new Set(['0xbanned']))
      wsById.get('0xbanned')!.send = jest.fn(() => {
        throw new Error('socket gone')
      }) as never
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(wsById.get('0xbanned')!.end).toHaveBeenCalledTimes(1)
      await sweep[STOP_COMPONENT]!()
    })

    it('should keep sweeping the remaining peers after a failing close', async () => {
      const { sweep, wsById } = await buildSweep(['0xbanned', '0xalsobanned'], new Set(['0xbanned', '0xalsobanned']))
      wsById.get('0xbanned')!.end = jest.fn(() => {
        throw new Error('already closed')
      }) as never
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(sentMessages.get('0xalsobanned')).toHaveLength(1)
      expect(wsById.get('0xalsobanned')!.end).toHaveBeenCalledTimes(1)
      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when the ban check itself throws for one peer', () => {
    it('should keep sweeping the rest', async () => {
      const { sweep, wsById } = await buildSweep(['0xexplodes', '0xbanned'], new Set(['0xbanned']))
      ;(banChecker.isBanned as jest.Mock).mockImplementation(async (id: string) => {
        if (id === '0xexplodes') throw new Error('gatekeeper unreachable')
        return id === '0xbanned'
      })
      await sweep[START_COMPONENT]!({} as never)

      await tickAndFlush()

      expect(wsById.get('0xbanned')!.end).toHaveBeenCalledTimes(1)
      await sweep[STOP_COMPONENT]!()
    })
  })

  describe('when stop is called', () => {
    it('should clear the interval so no further sweeps run', async () => {
      const { sweep } = await buildSweep(['0xa'], new Set(['0xa']))
      await sweep[START_COMPONENT]!({} as never)
      await tickAndFlush()
      const callsBefore = (banChecker.isBanned as jest.Mock).mock.calls.length

      await sweep[STOP_COMPONENT]!()
      await tickAndFlush()
      await tickAndFlush()

      expect((banChecker.isBanned as jest.Mock).mock.calls.length).toBe(callsBefore)
    })
  })
})
