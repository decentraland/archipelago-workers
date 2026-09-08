import { ILoggerComponent } from '@well-known-components/interfaces'
import { NatsMsg, SubscriptionCallback } from '@well-known-components/nats-component/dist/types'
import { getErrorMessage } from './errors'

/**
 * Wraps a NATS subscription callback so nothing can escape it.
 *
 * This is not defensive padding: nats.js invokes these callbacks from its own reader loop, so a
 * throw that escapes stops delivery on *every* subject on the connection, not just this one. The
 * publishers are out of this repo — comms-gatekeeper mints and publishes `island_changed` — so a
 * malformed payload must degrade to one dropped message, not a silently dead feed.
 *
 * Mirrored the same helper in the stats service until iteration 2 deleted that workspace; this is
 * the surviving copy.
 *
 * @param what - Short name of the message kind, used in the error log.
 * @param logger - Logger for delivery and handler failures.
 * @param handle - The actual message handler. May throw; the throw is contained and logged.
 * @returns A callback safe to hand to `nats.subscribe`.
 */
export function guarded(
  what: string,
  logger: ILoggerComponent.ILogger,
  handle: (message: NatsMsg) => void
): SubscriptionCallback {
  return (err, message) => {
    if (err) {
      logger.error(err)
      return
    }
    try {
      handle(message)
    } catch (error) {
      logger.error(`cannot process ${what} message ${getErrorMessage(error)}`)
    }
  }
}
