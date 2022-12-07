import { Lifecycle } from '@well-known-components/interfaces'
import { setupListener } from './controllers/listener'
import { setupRouter } from './controllers/routes'
import { ArchipelagoController, Options } from './controllers/archipelago'
import { AppComponents, GlobalContext, TestComponents } from './types'

const DEFAULT_ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL = 1000 * 60 * 2 // 2 min
const DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL = 10000

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, metrics, config, logs, transportRegistry, publisher } = components

  const archipelagoConfig: Options = {
    components: { logs, publisher, metrics },
    flushFrequency: await config.requireNumber('ARCHIPELAGO_FLUSH_FREQUENCY'),
    joinDistance: await config.requireNumber('ARCHIPELAGO_JOIN_DISTANCE'),
    leaveDistance: await config.requireNumber('ARCHIPELAGO_LEAVE_DISTANCE'),
    roomPrefix: await config.getString('ROOM_PREFIX')
  }

  const livekitApiKey = await config.getString('LIVEKIT_API_KEY')
  const livekitApiSecret = await config.getString('LIVEKIT_API_SECRET')
  const livekitHost = await config.getString('LIVEKIT_HOST')
  if (livekitApiKey && livekitApiSecret && livekitHost) {
    archipelagoConfig.livekit = {
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      host: livekitHost,
      islandSize: await config.getNumber('LIVEKIT_ISLAND_SIZE')
    }
  }

  const logger = logs.getLogger('service')

  const archipelago = new ArchipelagoController(archipelagoConfig)

  transportRegistry.setListener(archipelago)

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
      publisher.publishServiceDiscoveryMessage()
    } catch (err: any) {
      logger.error(err)
    }
  }, serviceDiscoveryUpdateFreq)

  await setupListener(archipelago, { nats, config, logs })
}
