import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './ports/fetch'
import { createMetricsComponent } from '@well-known-components/metrics'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import { ArchipelagoComponent } from './controllers/ArchipelagoController'
import { createNatsComponent } from '@well-known-components/nats-component'

export type ArchipelagoComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
}

async function getLivekitConf(config: IConfigComponent) {
  const url = await config.requireString('LIVEKIT_URL')
  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')

  if (!url || !apiKey || !apiSecret) {
    return
  }

  return { url, apiKey, apiSecret }
}

async function getWsRoomServiceConf(config: IConfigComponent) {
  const url = await config.requireString('WS_ROOM_SERVICE_URL')
  const secret = await config.requireString('WS_ROOM_SERVICE_SECRET')

  if (!url || !secret) {
    return
  }

  return { url, secret }
}

export async function createArchipelagoComponent(components: ArchipelagoComponents): Promise<ArchipelagoComponent> {
  const { config } = components

  const flushFrequency = await config.requireNumber('ARCHIPELAGO_FLUSH_FREQUENCY')
  const joinDistance = await config.requireNumber('ARCHIPELAGO_JOIN_DISTANCE')
  const leaveDistance = await config.requireNumber('ARCHIPELAGO_LEAVE_DISTANCE')
  const maxPeersPerIsland = await config.requireNumber('ARCHIPELAGO_MAX_PEERS_PER_ISLAND')
  const workerSrcPath = await config.getString('ARCHIPELAGO_WORKER_SRC_PATH')

  const controller = new ArchipelagoComponent({
    flushFrequency,
    archipelagoParameters: {
      joinDistance,
      leaveDistance,
      maxPeersPerIsland,
      livekit: await getLivekitConf(config),
      wsRoomService: await getWsRoomServiceConf(config)
    },
    workerSrcPath,
    components
  })

  return controller
}

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const logs = await createLogComponent({})
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const metrics = await createMetricsComponent(metricDeclarations, { server, config })
  const nats = await createNatsComponent({ config, logs })
  const archipelago = await createArchipelagoComponent({ config, logs })

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    nats,
    archipelago
  }
}
