import { IslandChangedMessage, KickedReason } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { setupRoutes } from './controllers/routes'
import { craftMessage } from './logic/craft-message'
import { AppComponents, TestComponents } from './types'

// Frequency for the background ban sweep. Banned users who were already in a
// session at ban time are kicked within at most this many ms. Tunable via env.
const DEFAULT_BAN_SWEEP_INTERVAL_MS = 30_000
// Cap concurrent ban-check requests during a sweep so a high peer count doesn't
// open hundreds of sockets to comms-gatekeeper at once. Matches archipelago-core.
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

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  await setupRoutes(components)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, logs, peersRegistry, banChecker, config } = components

  const logger = logs.getLogger('ws-connector')

  const banSweepIntervalMs = (await config.getNumber('BAN_SWEEP_INTERVAL_MS')) ?? DEFAULT_BAN_SWEEP_INTERVAL_MS
  logger.info(`Ban sweep running every ${banSweepIntervalMs}ms`)
  setInterval(async () => {
    const peers = peersRegistry.snapshot()
    if (peers.length === 0) return
    await mapWithConcurrency(peers, BAN_SWEEP_CONCURRENCY, async ({ id }) => {
      try {
        if (!(await banChecker.isBanned(id))) return
        const ws = peersRegistry.getPeerWs(id)
        if (!ws) return
        logger.info(`Disconnecting banned user from comms`, { address: id })
        try {
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
  }, banSweepIntervalMs)
  nats.subscribe('engine.peer.*.island_changed', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[2]
      logger.debug(`publishing island change for ${id}`)
      const ws = peersRegistry.getPeerWs(id)
      if (ws) {
        const islandChanged = IslandChangedMessage.decode(message.data)
        const sendResult = ws.send(
          craftMessage({
            message: {
              $case: 'islandChanged',
              islandChanged
            }
          }),
          true
        )
        if (sendResult !== 1) {
          logger.warn(`Failed to send island change to peer ${id}, send returned ${sendResult}`)
        } else {
          logger.debug(`island change published for ${id}`)
        }
      }
    } catch (err: any) {
      logger.error(`cannot process island_changed message ${err.message}`)
    }
  })
}
