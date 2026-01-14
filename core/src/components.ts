import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@dcl/wkc-http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { AppComponents, GlobalContext, Transport } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createPublisherComponent } from './adapters/publisher'
import { createArchipelagoEngine } from './adapters/engine'
import { AccessToken, TrackSource } from './logic/livekit'
import { IConfigComponent } from '@well-known-components/interfaces'

async function createLivekitTransport(config: IConfigComponent): Promise<Transport> {
  const livekit = {
    apiKey: await config.requireString('LIVEKIT_API_KEY'),
    apiSecret: await config.requireString('LIVEKIT_API_SECRET'),
    host: await config.requireString('LIVEKIT_HOST'),
    islandSize: await config.getNumber('LIVEKIT_ISLAND_SIZE')
  }
  return {
    name: 'livekit',
    maxIslandSize: 100,
    async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
      const connStrs: Record<string, string> = {}
      for (const userId of userIds) {
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
        connStrs[userId] = `livekit:${livekit.host}?access_token=${await token.toJwt()}`
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
    transport: await createLivekitTransport(config)
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
