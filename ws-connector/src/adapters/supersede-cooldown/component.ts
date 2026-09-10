import { AppComponents } from '../../types'
import { ISupersedeCooldownComponent } from './types'

// Sized against the assignments it has to outlast, which are two, not one: Pulse publishes
// the handover on one cluster pass and the peer's own migration off it on the next, both
// exempt from the dwell debounce. So the span is 2 x Clusters:PassIntervalMs (2s today) plus
// the token mint and NATS drain. 5000 leaves roughly double that. Deliberately not derived
// from the explorer's recovery interval, which happens to be the same number: matching it
// guarantees only that the *first* retry is refused, and couples this to a constant in
// another repo that can change without anyone here noticing.
const DEFAULT_SUPERSEDE_COOLDOWN_MS = 5_000
// Entries are dropped as they are read, so this only bounds addresses superseded once and never
// looked up again. Reaching it takes more concurrent supersedes than this within one window.
const SWEEP_THRESHOLD = 1024

/**
 * Creates the guard that stops a superseded session from immediately retaking its address.
 *
 * Sessions are only ever identified by the wallet, so when a second client authenticates the
 * handler kicks the first — whose explorer reconnects at once and kicks the second straight
 * back. The two then trade the registry slot every recovery interval, and whichever holds it
 * when Pulse's handover assignment lands is handed the island, regardless of which session the
 * handover was for.
 *
 * Refusing the address for a window longer than a cluster pass settles it: the kicked session
 * backs off, and the new one still holds the slot when the handover lands.
 *
 * @param components - The config and logs components.
 * @returns The supersede cooldown component.
 */
export async function createSupersedeCooldown(
  components: Pick<AppComponents, 'config' | 'logs'>
): Promise<ISupersedeCooldownComponent> {
  const { config, logs } = components
  const logger = logs.getLogger('supersede-cooldown')
  // Deliberately not clamped to a positive number. A window of zero or less is already
  // expired by the time anything reads it, so configuring one turns the guard off without a
  // code change, and no separate disabled branch has to exist to make that true.
  const cooldownMs = (await config.getNumber('SUPERSEDE_COOLDOWN_MS')) ?? DEFAULT_SUPERSEDE_COOLDOWN_MS

  const expiryByAddress = new Map<string, number>()
  let lastSweepAt = 0

  logger.info(cooldownMs > 0 ? `Supersede cooldown is ${cooldownMs}ms` : 'Supersede cooldown is disabled')

  function onSuperseded(address: string): void {
    if (expiryByAddress.size >= SWEEP_THRESHOLD) {
      sweep()
    }

    expiryByAddress.set(address, Date.now() + cooldownMs)
  }

  function sweep(): void {
    const now = Date.now()
    // A sweep that frees nothing leaves the map over the threshold, so without this every
    // later write would pay a full scan — during the very burst that grew it.
    if (now - lastSweepAt < cooldownMs) {
      return
    }

    lastSweepAt = now
    for (const [address, expiry] of expiryByAddress) {
      if (now >= expiry) {
        expiryByAddress.delete(address)
      }
    }
  }

  function isCoolingDown(address: string): boolean {
    const expiry = expiryByAddress.get(address)
    if (expiry === undefined) {
      return false
    }

    if (Date.now() >= expiry) {
      expiryByAddress.delete(address)
      return false
    }

    return true
  }

  function size(): number {
    return expiryByAddress.size
  }

  return {
    onSuperseded,
    isCoolingDown,
    size
  }
}
