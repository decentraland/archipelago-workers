import { IslandChangedMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { setupRoutes } from './controllers/routes'
import { craftMessage } from './logic/craft-message'
import { AppComponents, GlobalContext, TestComponents } from './types'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  await setupRoutes(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, logs, peersRegistry } = components

  const logger = logs.getLogger('ws-connector')
  nats.subscribe('engine.peer.*.island_changed', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[2]
      logger.debug(`publishing island change for ${id}`)
      const ws = peersRegistry.getPeerWs(id)
      if (ws) {
        const islandChanged = IslandChangedMessage.decode(message.data)
        ws.send(
          craftMessage({
            message: {
              $case: 'islandChanged',
              islandChanged
            }
          }),
          true
        )
        logger.debug(`island change published for ${id}`)
      }
    } catch (err: any) {
      logger.error(`cannot process peer_connect message ${err.message}`)
    }
  })
}
