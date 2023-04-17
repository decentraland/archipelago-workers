import { HTTPProvider } from 'eth-connect'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './adapters/fetch'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createUwsHttpServer } from '@well-known-components/http-server/dist/uws'
import { createPublisherComponent } from './adapters/publisher'
import { createPeersRegistry } from './adapters/peers-registry'
import { getUnderlyingServer } from '@well-known-components/http-server'
import { TemplatedApp } from 'uWebSockets.js'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const server = await createUwsHttpServer<GlobalContext>({ config, logs }, { compression: false })
  const uws = await getUnderlyingServer<TemplatedApp>(server)

  await instrumentHttpServerWithMetrics({ server, metrics, config })

  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const nats = await createNatsComponent({ config, logs })
  const peersRegistry = await createPeersRegistry(uws)
  const publisher = await createPublisherComponent({ config, nats, peersRegistry })

  const ethNetwork = (await config.getString('ETH_NETWORK')) ?? 'goerli'
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
    publisher,
    ethereumProvider
  }
}
