import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  IHttpServerOptions,
  instrumentHttpServerWithPromClientRegistry
} from '@well-known-components/http-server'
import { createFetchComponent } from '@well-known-components/fetch-component'
import { createLogComponent } from '@well-known-components/logger'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createMetricsComponent } from '@well-known-components/metrics'
import { createContentComponent } from './adapters/content'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import { createStatsComponent } from './adapters/stats'
import { createCoreStatusComponent } from './adapters/core-status'
import { createClockComponent } from './adapters/clock'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const serverOptions: Partial<IHttpServerOptions> = {
    cors: {
      origin: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'TRACE', 'PATCH'],
      allowedHeaders: ['Cache-Control', 'Content-Type', 'Origin', 'Accept', 'User-Agent', 'X-Upload-Origin'],
      credentials: true,
      maxAge: 86400
    }
  }

  const server = await createServerComponent<GlobalContext>({ config, logs }, serverOptions)
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = createFetchComponent()
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const nats = await createNatsComponent({ config, logs })
  const content = await createContentComponent({ config, fetch })
  const stats = createStatsComponent()
  const clock = createClockComponent()
  const coreStatus = createCoreStatusComponent({ clock })

  await instrumentHttpServerWithPromClientRegistry({ server, metrics, config, registry: metrics.registry! })
  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    nats,
    content,
    stats,
    coreStatus,
    clock
  }
}
