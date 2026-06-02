import { IBaseComponent, IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { KickedReason } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { craftMessage } from '../logic/craft-message'
import { IPeersRegistryComponent } from './peers-registry'
import { IBanCheckerComponent } from './ban-checker'

const DEFAULT_BAN_SWEEP_INTERVAL_MS = 30_000
// Cap concurrent ban-check requests during a sweep so a high peer count doesn't
// open hundreds of sockets to comms-gatekeeper at once. Matches archipelago-core.
const BAN_SWEEP_CONCURRENCY = 20

// Duplicate of core/src/components.ts. Keep the two implementations in sync.
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

export async function createBanSweep(components: {
  config: IConfigComponent
  logs: ILoggerComponent
  peersRegistry: IPeersRegistryComponent
  banChecker: IBanCheckerComponent
}): Promise<IBaseComponent> {
  const { config, logs, peersRegistry, banChecker } = components
  const logger = logs.getLogger('ban-sweep')
  const intervalMs = (await config.getNumber('BAN_SWEEP_INTERVAL_MS')) ?? DEFAULT_BAN_SWEEP_INTERVAL_MS

  let handle: NodeJS.Timeout | undefined

  async function sweep(): Promise<void> {
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
        } catch (sendErr: any) {
          logger.warn(`Failed to send kicked message before close`, {
            address: id,
            error: sendErr?.message ?? 'unknown'
          })
        }
        try {
          ws.end()
        } catch (closeErr: any) {
          logger.warn(`Failed to close ws for banned user`, {
            address: id,
            error: closeErr?.message ?? 'unknown'
          })
        }
      } catch (err: any) {
        logger.warn(`Ban sweep iteration failed`, { address: id, error: err?.message ?? 'unknown' })
      }
    })
  }

  return {
    async start(): Promise<void> {
      logger.info(`Ban sweep running every ${intervalMs}ms`)
      handle = setInterval(sweep, intervalMs)
      // unref() so the timer doesn't keep the process alive on its own — the
      // HTTP server and NATS connection are what hold the event loop open in prod;
      // in tests, this lets Jest exit cleanly.
      handle.unref()
    },
    async stop(): Promise<void> {
      if (handle) {
        clearInterval(handle)
        handle = undefined
      }
    }
  }
}
