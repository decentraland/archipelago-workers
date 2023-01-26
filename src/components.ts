import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './ports/fetch'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createTransportRegistryComponent } from './ports/transport-registry'
import { WebSocketServer } from 'ws'
import { createPublisherComponent } from './ports/publisher'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const wss = new WebSocketServer({ noServer: true })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const server = await createServerComponent<GlobalContext>({ config, logs, ws: wss }, {})

  await instrumentHttpServerWithMetrics({ server, metrics, config })

  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const nats = await createNatsComponent({ config, logs })
  const transportRegistry = await createTransportRegistryComponent()
  const publisher = await createPublisherComponent({ config, nats })

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    nats,
    transportRegistry,
    publisher
  }
}
