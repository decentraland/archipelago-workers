import { getErrorMessage } from '../../logic/errors'
import { normalizeAddress } from '../../logic/address'
import { AppComponents } from '../../types'
import { IDenyListComponent } from './types'

const DEFAULT_DENYLIST_JSON_URL = 'https://config.decentraland.org/denylist.json'
const DENY_LIST_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Creates the platform deny-list gate.
 *
 * The list is a remote JSON document refreshed at most once per TTL window and held in memory,
 * because this is consulted twice on every WebSocket handshake — once on the claimed address and
 * again on the authenticated one.
 *
 * @param components - The config, logs and fetch components.
 * @returns The deny list component.
 */
export async function createDenyListComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch'>
): Promise<IDenyListComponent> {
  const { config, logs, fetch } = components
  const logger = logs.getLogger('deny-list')
  const url = (await config.getString('DENYLIST_JSON_URL')) || DEFAULT_DENYLIST_JSON_URL

  let cached: Set<string> = new Set()
  let lastFetched = 0

  async function refresh(): Promise<Set<string>> {
    if (Date.now() - lastFetched < DENY_LIST_TTL_MS) {
      return cached
    }

    try {
      const response = await fetch.fetch(url)
      if (!response.ok) {
        // Release the body before discarding it: an unconsumed undici body pins its socket and
        // buffers the received bytes until GC. Bounded by the TTL here, unlike the ban check,
        // but the same leak.
        await response.body?.cancel().catch(() => {})
        throw new Error(`Failed to fetch deny list, status: ${response.status}`)
      }
      const data = (await response.json()) as { users?: { wallet: string }[] }
      if (data.users && Array.isArray(data.users)) {
        cached = new Set(data.users.map((user) => normalizeAddress(user.wallet)))
      } else {
        logger.warn('Deny list is missing "users" field or it is not an array.')
        cached = new Set()
      }
    } catch (error) {
      logger.error(`Error fetching deny list: ${getErrorMessage(error)}`)
    }

    // Always update the timestamp, even on failure. Otherwise, every handshake
    // retries the failed fetch, adding latency to all connections when the
    // deny list endpoint is down.
    lastFetched = Date.now()

    return cached
  }

  async function isDenylisted(address: string): Promise<boolean> {
    return (await refresh()).has(address)
  }

  return { isDenylisted }
}
