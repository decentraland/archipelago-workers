import { AppComponents } from '../../types'
import { getErrorMessage } from '../../logic/errors'
import { IBanCheckerComponent } from './types'

const BAN_CHECK_TIMEOUT_MS = 1000

/**
 * Creates the client that asks comms-gatekeeper whether an address is platform-banned.
 *
 * Deliberately fails open on every path — unset URL, non-OK status, network error — because this
 * sits in the WebSocket handshake: a gatekeeper outage must not lock everyone out of the platform.
 *
 * @param components - The config, logs and fetch components.
 * @returns The ban checker component.
 */
export async function createBanChecker(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch'>
): Promise<IBanCheckerComponent> {
  const { config, logs, fetch } = components
  const logger = logs.getLogger('ban-checker')
  const url = (await config.getString('COMMS_GATEKEEPER_URL'))?.replace(/\/$/, '')

  if (url) {
    logger.info(`Ban check enabled — comms-gatekeeper at ${url}`)
  } else {
    logger.warn(`COMMS_GATEKEEPER_URL not set — ban checks disabled, all WS handshakes allowed`)
  }

  async function isBanned(address: string): Promise<boolean> {
    if (!url) {
      return false
    }

    try {
      const response = await fetch.fetch(`${url}/users/${encodeURIComponent(address)}/bans`, {
        signal: AbortSignal.timeout(BAN_CHECK_TIMEOUT_MS)
      })

      if (!response.ok) {
        // Release the body we are about to discard. An unconsumed undici body pins its socket
        // and buffers the received bytes until GC — and this runs on every handshake, so a
        // gatekeeper returning 5xx (exactly the outage this fails open for) would otherwise
        // leak a connection per connecting player.
        await response.body?.cancel().catch(() => {})
        logger.warn(`Ban check returned non-OK status, allowing connection`, {
          address,
          status: response.status
        })
        return false
      }

      const body = (await response.json()) as { data?: { isBanned?: boolean } }

      return body?.data?.isBanned === true
    } catch (error) {
      logger.warn(`Ban check failed, allowing connection`, { address, error: getErrorMessage(error) })
      return false
    }
  }

  return { isBanned }
}
