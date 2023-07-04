import { Lifecycle } from '@well-known-components/interfaces'
import { ArchipelagoController, Options } from './controllers/archipelago'
import { AppComponents, TestComponents } from './types'
import { setupListener } from './controllers/listener'

const DEFAULT_ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL = 1000 * 60 * 2 // 2 min
const DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL = 10000

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, metrics, config, logs, publisher } = components

  const archipelagoConfig: Options = {
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
  }

  const logger = logs.getLogger('service')

  const archipelago = new ArchipelagoController(archipelagoConfig)
  const islandsStatusUpdateFreq =
    (await config.getNumber('ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL')) ??
    DEFAULT_ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL
  setInterval(() => {
    try {
      publisher.publishIslandsReport(archipelago.getIslands())
    } catch (err: any) {
      logger.error(err)
    }
  }, islandsStatusUpdateFreq)

  const serviceDiscoveryUpdateFreq =
    (await config.getNumber('ARCHIPELAGO_STATUS_UPDATE_INTERVAL')) ?? DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL

  setInterval(() => {
    try {
      publisher.publishServiceDiscoveryMessage(archipelago.getPeerCount())
    } catch (err: any) {
      logger.error(err)
    }
  }, serviceDiscoveryUpdateFreq)

  await setupListener(archipelago, { nats, config, logs })
}
