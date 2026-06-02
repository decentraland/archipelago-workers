import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'

const BAN_CHECK_TIMEOUT_MS = 1000

export type IBanCheckerComponent = {
  isBanned(address: string): Promise<boolean>
}

export async function createBanChecker(components: {
  config: IConfigComponent
  logs: ILoggerComponent
}): Promise<IBanCheckerComponent> {
  const { config, logs } = components
  const logger = logs.getLogger('ban-checker')
  const url = (await config.getString('COMMS_GATEKEEPER_URL'))?.replace(/\/$/, '')
  if (url) {
    logger.info(`Ban check enabled — comms-gatekeeper at ${url}`)
  } else {
    logger.warn(`COMMS_GATEKEEPER_URL not set — ban checks disabled, all WS handshakes allowed`)
  }

  // Unset URL → skip (local dev). Errors → fail OPEN: a gatekeeper outage
  // must not lock everyone out of the platform.
  // Near-duplicate of core/src/components.ts isBanned. Keep both in sync.
  async function isBanned(address: string): Promise<boolean> {
    if (!url) return false
    try {
      const response = await fetch(`${url}/users/${encodeURIComponent(address)}/bans`, {
        signal: AbortSignal.timeout(BAN_CHECK_TIMEOUT_MS)
      })
      if (!response.ok) {
        logger.warn(`Ban check returned non-OK status, allowing connection`, {
          address,
          status: response.status
        })
        return false
      }
      const body = (await response.json()) as { data?: { isBanned?: boolean } }
      return body?.data?.isBanned === true
    } catch (error: any) {
      logger.warn(`Ban check failed, allowing connection`, {
        address,
        error: error?.message ?? 'Unknown error'
      })
      return false
    }
  }

  return { isBanned }
}
