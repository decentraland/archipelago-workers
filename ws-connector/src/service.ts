import { IslandChangedMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { setupRoutes } from './controllers/routes'
import { craftMessage } from './logic/craft-message'
import { normalizeAddress } from './logic/address'
import { guarded } from './logic/nats'
import { AppComponents, InternalWebSocket, TestComponents } from './types'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  await setupRoutes(components)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, logs, peersRegistry, config, metrics } = components

  const logger = logs.getLogger('ws-connector')

  const dedupMs = (await config.getNumber('ISLAND_CHANGED_DEDUP_MS')) ?? 10_000

  function forward(ws: InternalWebSocket, id: string, data: Uint8Array): void {
    const islandChanged = IslandChangedMessage.decode(data)

    // The same room handed to the same socket twice inside the window is the client's own first
    // assignment arriving again through the re-announce path; it already holds a token for it.
    const userData = ws.getUserData()
    const now = Date.now()
    if (
      dedupMs > 0 &&
      userData.lastIslandId === islandChanged.islandId &&
      userData.lastIslandAt !== undefined &&
      now - userData.lastIslandAt < dedupMs
    ) {
      metrics.increment('dcl_ws_connector_island_changed_deduplicated_total')
      return
    }
    userData.lastIslandId = islandChanged.islandId
    userData.lastIslandAt = now

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
  }

  // Five tokens: the last is the session key the message is addressed to. Every replica
  // receives every event and the (address, session) lookup is the filter, so a socket held for
  // another session of the same wallet never sees it.
  nats.subscribe(
    'engine.peer.*.island_changed.*',
    guarded('island_changed', logger, (message) => {
      const [, , addressToken, , sessionToken] = message.subject.split('.')
      const id = normalizeAddress(addressToken)
      const ws = peersRegistry.getPeerWs(id, sessionToken.toLowerCase())
      if (!ws) {
        // Only a replica that holds the wallet under another session can tell a stale session
        // apart from ordinary fan-out to the replicas that do not hold the wallet at all.
        if (peersRegistry.hasPeer(id)) {
          metrics.increment('dcl_ws_connector_island_changed_no_session_socket_total')
        }
        return
      }
      forward(ws, id, message.data)
    })
  )

  // The session-less subject comms-gatekeeper publishes for an assignment that carries no
  // session (an older Pulse) — delivered to the newest socket of the address.
  nats.subscribe(
    'engine.peer.*.island_changed',
    guarded('island_changed', logger, (message) => {
      const id = normalizeAddress(message.subject.split('.')[2])
      const ws = peersRegistry.getNewestPeerWs(id)
      if (!ws) {
        return
      }
      forward(ws, id, message.data)
    })
  )
}
