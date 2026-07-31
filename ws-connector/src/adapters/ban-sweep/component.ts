import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { KickedReason } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { craftMessage } from '../../logic/craft-message'
import { getErrorMessage } from '../../logic/errors'
import { AppComponents } from '../../types'
import { IBanSweepComponent } from './types'

const DEFAULT_BAN_SWEEP_INTERVAL_MS = 30_000
// Cap concurrent ban-check requests during a sweep so a high peer count doesn't
// open hundreds of sockets to comms-gatekeeper at once.
const BAN_SWEEP_CONCURRENCY = 20

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/**
 * Creates the background sweep that disconnects peers banned after they connected.
 *
 * The handshake ban check only runs once, at connect time, so without this a peer banned
 * mid-session stays in comms until they reconnect. Each pass snapshots the registry, re-checks
 * every peer against comms-gatekeeper (bounded concurrency), and kicks the ones now banned.
 *
 * Every step is individually guarded: one peer's failed check, send or close must not abort the
 * rest of the sweep.
 *
 * @param components - The config, logs, peers registry and ban checker components.
 * @returns The ban sweep component. It exposes only lifecycle hooks.
 */
export async function createBanSweep(
  components: Pick<AppComponents, 'config' | 'logs' | 'peersRegistry' | 'banChecker'>
): Promise<IBanSweepComponent> {
  const { config, logs, peersRegistry, banChecker } = components
  const logger = logs.getLogger('ban-sweep')
  const intervalMs = (await config.getNumber('BAN_SWEEP_INTERVAL_MS')) ?? DEFAULT_BAN_SWEEP_INTERVAL_MS

  let handle: NodeJS.Timeout | undefined
  let sweeping = false

  async function sweep(): Promise<void> {
    // setInterval does not await an async callback, so a sweep slower than the interval would
    // otherwise have the next one start on top of it. Each sweep carries its own concurrency
    // budget, so overlapping them multiplies load on comms-gatekeeper — and the thing that
    // makes a sweep slow is a struggling gatekeeper, so the pile-up feeds itself. Worth
    // logging: it means the interval is too short for the peer count, or the ban check is
    // degraded.
    if (sweeping) {
      logger.warn(`Skipping ban sweep, the previous one is still running`)
      return
    }

    sweeping = true
    try {
      await runSweep()
    } finally {
      sweeping = false
    }
  }

  async function runSweep(): Promise<void> {
    const peers = peersRegistry.snapshot()
    if (peers.length === 0) return
    await mapWithConcurrency(peers, BAN_SWEEP_CONCURRENCY, async ({ id }) => {
      try {
        if (!(await banChecker.isBanned(id))) return
        const ws = peersRegistry.getPeerWs(id)
        if (!ws) return
        logger.info(`Disconnecting banned user from comms`, { address: id })
        try {
          // KR_NEW_SESSION reused because the protocol enum lacks a KR_BANNED reason.
          // See ws-handler.ts handshake path for the same workaround.
          ws.send(
            craftMessage({
              message: { $case: 'kicked', kicked: { reason: KickedReason.KR_NEW_SESSION } }
            }),
            true
          )
        } catch (sendError) {
          logger.warn(`Failed to send kicked message before close`, {
            address: id,
            error: getErrorMessage(sendError)
          })
        }
        try {
          ws.end()
        } catch (closeError) {
          logger.warn(`Failed to close ws for banned user`, {
            address: id,
            error: getErrorMessage(closeError)
          })
        }
      } catch (error) {
        logger.warn(`Ban sweep iteration failed`, { address: id, error: getErrorMessage(error) })
      }
    })
  }

  async function start(): Promise<void> {
    logger.info(`Ban sweep running every ${intervalMs}ms`)
    handle = setInterval(sweep, intervalMs)
    // unref() so the timer doesn't keep the process alive on its own — the
    // HTTP server and NATS connection are what hold the event loop open in prod;
    // in tests, this lets Jest exit cleanly.
    handle.unref()
  }

  async function stop(): Promise<void> {
    if (handle) {
      clearInterval(handle)
      handle = undefined
    }
  }

  return {
    [START_COMPONENT]: start,
    [STOP_COMPONENT]: stop
  }
}
