import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createPublisherComponent } from './adapters/publisher'
import { createArchipelagoEngine } from './adapters/engine'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  await instrumentHttpServerWithMetrics({ server, metrics, config })

  const statusChecks = await createStatusCheckComponent({ server, config })
  const nats = await createNatsComponent({ config, logs })
  const publisher = await createPublisherComponent({ config, nats })

  const engine = createArchipelagoEngine({
    components: { logs, metrics, publisher },
    flushFrequency: await config.requireNumber('ARCHIPELAGO_FLUSH_FREQUENCY'),
    joinDistance: await config.requireNumber('ARCHIPELAGO_JOIN_DISTANCE'),
    leaveDistance: await config.requireNumber('ARCHIPELAGO_LEAVE_DISTANCE'),
    roomPrefix: await config.getString('ROOM_PREFIX'),
    livekit: {
      apiKey: await config.requireString('LIVEKIT_API_KEY'),
      apiSecret: await config.requireString('LIVEKIT_API_SECRET'),
      host: await config.requireString('LIVEKIT_HOST'),
      islandSize: await config.getNumber('LIVEKIT_ISLAND_SIZE')
    }
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
