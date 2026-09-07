import { ParcelChangesBatch } from '@dcl/protocol/out-js/decentraland/pulse/pulse_presence.gen'

/**
 * The consumer-side half of C1 §5: Pulse lowercases every realm and address at ingest, so anything
 * that arrives on `engine.parcel_changes` in another case is a producer violating the contract.
 *
 * This is the shape of the check each consumer owes the feed, written once here so the contract
 * pack's `07-invalid-mixed-case-realm` fixture has something to fire against. It reports and
 * nothing more: a consumer logs the violation and keeps serving its current state, because
 * dropping presence over one mis-cased realm is worse than carrying it. Hence `assert` rather than
 * a normalizing filter — silently lowercasing here would hide the producer bug from everyone.
 *
 * @param batch - a decoded batch, as it came off the wire.
 * @throws if any `realm` or `address` is not already its own lowercase form.
 */
export function assertCanonicalBatch(batch: ParcelChangesBatch): void {
  for (const [index, change] of batch.changes.entries()) {
    for (const field of ['realm', 'address'] as const) {
      const value = change[field]
      if (value !== value.toLowerCase()) {
        throw new Error(
          `Non-canonical ${field} on ${batch.serverName} seq ${batch.seq} change ${index}: ${value}. ` +
            `C1 §5 requires realms and addresses lowercased at the producer.`
        )
      }
    }
  }
}
