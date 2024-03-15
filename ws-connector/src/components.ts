import { HTTPProvider } from 'eth-connect'
import { createConfigComponent, createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { AppComponents } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createPeersRegistry } from './adapters/peers-registry'
import { createFetchComponent } from '@well-known-components/fetch-component'
import { createUWsComponent } from '@well-known-components/uws-http-server'
import { createMetricsComponent } from '@well-known-components/metrics'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const server = await createUWsComponent({ config, logs })

  const fetch = createFetchComponent()

  const natsLogs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'WARN' }) })
  const nats = await createNatsComponent({ config, logs: natsLogs })
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
    fetch,
    metrics,
    nats,
    peersRegistry,
    ethereumProvider
  }
}
