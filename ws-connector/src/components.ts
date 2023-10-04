import { HTTPProvider } from 'eth-connect'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createUwsHttpServer } from '@well-known-components/http-server/dist/uws'
import { createPeersRegistry } from './adapters/peers-registry'
import { createFetchComponent } from '@well-known-components/fetch-component'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const server = await createUwsHttpServer<GlobalContext>({ config, logs }, { compression: false, idleTimeout: 90 })
  await instrumentHttpServerWithMetrics({ server, metrics, config })

  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = createFetchComponent()
  const nats = await createNatsComponent({ config, logs })
  const peersRegistry = await createPeersRegistry()

  const ethNetwork = (await config.getString('ETH_NETWORK')) ?? 'sepolia'
  const ethereumProvider = new HTTPProvider(
    `https://rpc.decentraland.org/${encodeURIComponent(ethNetwork)}?project=archipelago`,
    { fetch: fetch.fetch }
  )

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    nats,
    peersRegistry,
    ethereumProvider
  }
}
