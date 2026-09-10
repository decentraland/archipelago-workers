import { AppComponents, InternalWebSocket } from '../types'
import { normalizeAddress } from './address'
import { craftKickedMessage } from './craft-message'
import { getErrorMessage } from './errors'
import { guarded } from './nats'

/**
 * Subscribes this replica to the session events that make duplicate-session handling global.
 *
 * `peersRegistry` lives in one process, so a handshake can only ever kick a socket that happens
 * to share a replica with it. Two clients on one wallet that land on different replicas never
 * see each other: both stay registered, and since `island_changed` is delivered to every replica
 * and filtered by `getPeerWs`, both are handed the wallet's island.
 *
 * Every welcome is announced on `peer.{addr}.connect` carrying the new socket's session id.
 * A replica holding a socket for that address under a different id kicks it and announces
 * `peer.{addr}.superseded`, which every replica turns into a cooldown — so the kicked client is
 * refused wherever it reconnects, not only where it was kicked.
 *
 * @param components - The logs, metrics, nats, peers registry and supersede cooldown components.
 */
export function registerSupersedeSubscriptions(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'nats' | 'peersRegistry' | 'supersedeCooldown'>
): void {
  const { logs, metrics, nats, peersRegistry, supersedeCooldown } = components
  const logger = logs.getLogger('supersede')

  function supersede(address: string, ws: InternalWebSocket): void {
    // Marked before anything else, the way safeEndWebSocket does in the handshake path: the
    // close callback that would otherwise set it runs later, so a second announcement landing
    // in between would kick and announce this same dying socket all over again.
    ws.getUserData().isClosed = true

    try {
      if (ws.send(craftKickedMessage(), true) !== 1) {
        logger.warn(`Superseded socket did not take the kicked message`, { address })
      }
    } catch (error) {
      logger.warn(`Failed to send kicked message to the superseded socket`, {
        address,
        error: getErrorMessage(error)
      })
    }

    try {
      ws.end()
    } catch (error) {
      logger.warn(`Failed to close the superseded socket`, { address, error: getErrorMessage(error) })
    }

    // Armed here as well as on the announcement below, which comes back to this replica too.
    // Re-arming only pushes the expiry further out, and doing it now closes the round trip's
    // worth of time in which the kicked client could have been let back in here.
    metrics.increment('dcl_ws_connector_supersede_kicks_total')
    supersedeCooldown.onSuperseded(address)
    nats.publish(`peer.${address}.superseded`)
  }

  nats.subscribe(
    'peer.*.connect',
    guarded('connect', logger, (message) => {
      const address = normalizeAddress(message.subject.split('.')[1])
      const sessionId = Buffer.from(message.data).toString('utf8')
      const ws = peersRegistry.getPeerWs(address)
      if (!ws) {
        return
      }

      const data = ws.getUserData()
      const held = data.sessionId
      // Strictly newer, not merely different. Two welcomes can cross on the wire, and a
      // replica that only asks "is this announcement about the socket I hold?" answers no to
      // both and kicks the winner along with the loser — leaving the wallet with no session
      // anywhere. Comparing the ids makes the verdict a pure function of the two, so every
      // replica reaches the same one and exactly one socket survives.
      //
      // Two cases need no branch of their own: the publisher hearing its own announcement,
      // where the ids are equal, and a replica still on the previous build announcing without
      // a payload during a rolling deploy, where the empty id sorts below every real one.
      if (held === undefined || sessionId <= held || data.isClosed) {
        return
      }

      logger.info(`Superseding a session held on this replica`, { address })
      supersede(address, ws)
    })
  )

  nats.subscribe(
    'peer.*.superseded',
    guarded('superseded', logger, (message) => {
      supersedeCooldown.onSuperseded(normalizeAddress(message.subject.split('.')[1]))
    })
  )
}
