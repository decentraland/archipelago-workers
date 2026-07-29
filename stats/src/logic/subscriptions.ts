import { Heartbeat, ServiceDiscoveryMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { AppComponents } from '../types'
import { decodeIslandsReport } from './decode'

type SubscriptionComponents = Pick<AppComponents, 'nats' | 'logs' | 'stats' | 'coreStatus'>

/**
 * Wires the four NATS subscriptions stats builds its state from. Two are published by this
 * repo's WS Connector (`peer.*`); since iteration 1 of the Archipelago => Pulse migration the
 * other two come from Pulse.
 *
 * NOTE we are using callbacks instead of async, for NATS subscriptions. There are some risks
 * associated with this pattern so we keep the callbacks small and fast — see
 * https://github.com/nats-io/nats.js/#async-vs-callbacks
 *
 * Every handler catches its own errors. The NATS component invokes these callbacks unguarded,
 * so a throw escaping one unwinds into the client's reader loop and stops delivery on *every*
 * subject — one malformed frame would freeze the whole stats surface, with `/status` still
 * answering 200. A decode is exactly what throws here, and the publishers of `engine.islands`
 * and `engine.discovery` now live outside this repo.
 */
export function registerSubscriptions({ nats, logs, stats, coreStatus }: SubscriptionComponents): void {
  const logger = logs.getLogger('stats')

  nats.subscribe('peer.*.disconnect', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[1]
      stats.onPeerDisconnected(id)
    } catch (err: any) {
      logger.error(`cannot process disconnect message ${err.message}`)
    }
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
      stats.onIslandsDataReceived(decodeIslandsReport(message.data))
    } catch (err: any) {
      logger.error(`cannot process islands message ${err.message}`)
    }
  })

  nats.subscribe('engine.discovery', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      coreStatus.onServiceDiscoveryReceived(ServiceDiscoveryMessage.decode(message.data))
    } catch (err: any) {
      logger.error(`cannot process discovery message ${err.message}`)
    }
  })
}
