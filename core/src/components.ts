import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { AppComponents, GlobalContext, Transport } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createPublisherComponent } from './adapters/publisher'
import { createArchipelagoEngine } from './adapters/engine'
import { AccessToken, TrackSource } from './logic/livekit'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'

const BAN_CHECK_TIMEOUT_MS = 1000

async function createLivekitTransport(config: IConfigComponent, logs: ILoggerComponent): Promise<Transport> {
  const logger = logs.getLogger('livekit-transport')
  const livekit = {
    apiKey: await config.requireString('LIVEKIT_API_KEY'),
    apiSecret: await config.requireString('LIVEKIT_API_SECRET'),
    host: await config.requireString('LIVEKIT_HOST'),
    islandSize: await config.getNumber('LIVEKIT_ISLAND_SIZE')
  }
  const commsGatekeeperUrl = (await config.getString('COMMS_GATEKEEPER_URL'))?.replace(/\/$/, '')

  // When COMMS_GATEKEEPER_URL is unset, ban checks are skipped — preserves the
  // pre-integration behavior so local dev/tests don't need the gatekeeper running.
  // On HTTP error, timeout, or non-200, we fail OPEN: mint the token anyway and
  // log a warning. A gatekeeper outage must not stop island formation across the
  // platform; a banned user slipping through during an outage is the lesser harm.
  async function isBanned(address: string): Promise<boolean> {
    if (!commsGatekeeperUrl) return false
    try {
      const response = await fetch(`${commsGatekeeperUrl}/users/${address}/bans`, {
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

  async function mintToken(userId: string, roomId: string): Promise<string> {
    const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity: userId,
      ttl: 5 * 60 // 5 minutes
    })
    token.addGrant({
      roomJoin: true,
      room: roomId,
      roomList: false,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canPublishSources: [TrackSource.MICROPHONE]
    })
    return `livekit:${livekit.host}?access_token=${await token.toJwt()}`
  }

  return {
    name: 'livekit',
    maxIslandSize: livekit.islandSize ?? 100,
    async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
      const entries = await Promise.all(
        userIds.map(async (userId) => {
          if (await isBanned(userId)) {
            logger.info(`Skipping connection string for banned user`, { address: userId, roomId })
            return null
          }
          return [userId, await mintToken(userId, roomId)] as const
        })
      )
      const connStrs: Record<string, string> = {}
      for (const entry of entries) {
        if (entry) connStrs[entry[0]] = entry[1]
      }
      return connStrs
    }
  }
}

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  await instrumentHttpServerWithPromClientRegistry({ server, metrics, config, registry: metrics.registry! })

  const statusChecks = await createStatusCheckComponent({ server, config })
  const nats = await createNatsComponent({ config, logs })
  const publisher = await createPublisherComponent({ config, nats })

  const engine = createArchipelagoEngine({
    components: { logs, metrics },
    joinDistance: await config.requireNumber('ARCHIPELAGO_JOIN_DISTANCE'),
    leaveDistance: await config.requireNumber('ARCHIPELAGO_LEAVE_DISTANCE'),
    roomPrefix: await config.getString('ROOM_PREFIX'),
    transport: await createLivekitTransport(config, logs)
  })

  return {
    config,
    logs,
    server,
    statusChecks,
    metrics,
    nats,
    publisher,
    engine
  }
}
