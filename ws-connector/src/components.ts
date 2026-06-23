import { HTTPProvider, FetchFunction } from 'eth-connect'
import { createConfigComponent, createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { AppComponents } from './types'
import { metricDeclarations } from './metrics'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createPeersRegistry } from './adapters/peers-registry'
import { createBanChecker } from './adapters/ban-checker'
import { createBanSweep } from './adapters/ban-sweep'
import { createFetchComponent } from '@dcl/fetch-component'
import { createUWsComponent } from '@dcl/uws-http-server'
import { createMetricsComponent } from '@dcl/metrics'

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
  const banChecker = await createBanChecker({ config, logs })
  const banSweep = await createBanSweep({ config, logs, peersRegistry, banChecker })

  const ethNetwork = (await config.getString('ETH_NETWORK')) ?? 'sepolia'
  const ethereumProvider = new HTTPProvider(
    `https://rpc.decentraland.org/${encodeURIComponent(ethNetwork)}?project=archipelago`,
    // The native fetch (global Request/Response) is runtime-compatible with eth-connect's FetchFunction,
    // but their request-init types diverge (mode: RequestMode vs string), so cast it here.
    { fetch: fetch.fetch as unknown as FetchFunction }
  )

  return {
    config,
    logs,
    server,
    fetch,
    metrics,
    nats,
    peersRegistry,
    banChecker,
    banSweep,
    ethereumProvider
  }
}
