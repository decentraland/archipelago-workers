import { IslandChangedMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { setupRoutes } from './controllers/routes'
import { craftMessage } from './logic/craft-message'
import { normalizeAddress } from './logic/address'
import { guarded } from './logic/nats'
import { AppComponents, TestComponents } from './types'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  await setupRoutes(components)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, logs, peersRegistry } = components

  const logger = logs.getLogger('ws-connector')

  // Subscribed unprefixed and without a queue group, both deliberately: comms-gatekeeper
  // publishes to this literal subject, and every replica must receive every event so the one
  // actually holding the peer's socket can forward it. `getPeerWs` is the filter.
  nats.subscribe(
    'engine.peer.*.island_changed',
    guarded('island_changed', logger, (message) => {
      // Peers register under their lower-cased address and this lookup is an exact string
      // match, so normalize the subject token before hitting the registry.
      const id = normalizeAddress(message.subject.split('.')[2])
      logger.debug(`publishing island change for ${id}`)
      const ws = peersRegistry.getPeerWs(id)
      if (!ws) {
        return
      }

      const islandChanged = IslandChangedMessage.decode(message.data)
      const sendResult = ws.send(
        craftMessage({
          message: {
            $case: 'islandChanged',
            islandChanged
          }
        }),
        true
      )
      if (sendResult !== 1) {
        logger.warn(`Failed to send island change to peer ${id}, send returned ${sendResult}`)
      } else {
        logger.debug(`island change published for ${id}`)
      }
    })
  )
}
