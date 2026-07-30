import { Heartbeat, ServiceDiscoveryMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { NatsMsg, SubscriptionCallback } from '@well-known-components/nats-component/dist/types'
import { AppComponents } from '../types'
import { decodeIslandsReport } from './decode'

type SubscriptionComponents = Pick<AppComponents, 'nats' | 'logs' | 'stats' | 'coreStatus'>

// NOTE we are using callbacks instead of async for NATS subscriptions, see
// https://github.com/nats-io/nats.js/#async-vs-callbacks

/** `peer.*` come from this repo's WS Connector; `engine.*` from Pulse. */
export function registerSubscriptions({ nats, logs, stats, coreStatus }: SubscriptionComponents): void {
  const logger = logs.getLogger('stats')

  // A throw escaping a callback stops delivery on every subject, not just this one, so every
  // handler is wrapped. Decoding is what throws, and the engine.* publishers are out of repo.
  function guarded(what: string, handle: (message: NatsMsg) => void): SubscriptionCallback {
    return (err, message) => {
      if (err) {
        logger.error(err)
        return
      }
      try {
        handle(message)
      } catch (err: any) {
        logger.error(`cannot process ${what} message ${err.message}`)
      }
    }
  }

  nats.subscribe(
    'peer.*.disconnect',
    guarded('disconnect', (message) => {
      stats.onPeerDisconnected(message.subject.split('.')[1])
    })
  )

  nats.subscribe(
    'peer.*.heartbeat',
    guarded('heartbeat', (message) => {
      const position = Heartbeat.decode(message.data).position
      if (!position) {
        return
      }
      const id = message.subject.split('.')[1]
      stats.onPeerUpdated(id, { address: id, time: Date.now(), x: position.x, y: position.y, z: position.z })
    })
  )

  nats.subscribe(
    'engine.islands',
    guarded('islands', (message) => {
      stats.onIslandsDataReceived(decodeIslandsReport(message.data))
    })
  )

  nats.subscribe(
    'engine.discovery',
    guarded('discovery', (message) => {
      coreStatus.onServiceDiscoveryReceived(ServiceDiscoveryMessage.decode(message.data))
    })
  )
}
