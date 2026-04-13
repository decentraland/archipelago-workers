import {
  Heartbeat,
  IslandStatusMessage,
  ServiceDiscoveryMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { AppComponents, GlobalContext, IslandData, TestComponents } from './types'

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

  const { logs, nats, stats, coreStatus } = components

  const logger = logs.getLogger('stats')

  nats.subscribe('peer.*.disconnect', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    const id = message.subject.split('.')[1]
    stats.onPeerDisconnected(id)
  })

  nats.subscribe('peer.*.heartbeat', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[1]
      const decodedMessage = Heartbeat.decode(message.data)
      const position = decodedMessage.position
      if (!position) {
        return
      }
      stats.onPeerUpdated(id, {
        address: id,
        time: Date.now(),
        x: position.x,
        y: position.y,
        z: position.z
      })
    } catch (err: any) {
      logger.error(`cannot process heartbeat message ${err.message}`)
    }
  })

  nats.subscribe('engine.islands', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const decodedMessage = IslandStatusMessage.decode(message.data)
      const report: IslandData[] = []
      for (const { id, peers, maxPeers, center, radius } of decodedMessage.data) {
        if (!center) {
          continue
        }
        report.push({
          id,
          peers,
          maxPeers,
          radius,
          center: [center.x, center.y, center.z]
        })
      }
      stats.onIslandsDataReceived(report)
    } catch (err: any) {
      logger.error(`cannot process islands message ${err.message}`)
    }
  })

  nats.subscribe('engine.discovery', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }
    coreStatus.onServiceDiscoveryReceived(ServiceDiscoveryMessage.decode(message.data))
  })
}
