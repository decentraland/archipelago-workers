import { Heartbeat } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { AppComponents, TestComponents } from './types'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, config, logs, publisher, engine } = components

  const flushFrequency = await config.requireNumber('ARCHIPELAGO_FLUSH_FREQUENCY')
  const checkHeartbeatInterval = await config.requireNumber('CHECK_HEARTBEAT_INTERVAL')
  const logger = logs.getLogger('core')

  setInterval(
    () => {
      try {
        publisher.publishServiceDiscoveryMessage(engine.getPeerCount())
      } catch (err: any) {
        logger.error(err)
      }
    },
    (await config.getNumber('ARCHIPELAGO_STATUS_UPDATE_INTERVAL')) ?? 10000
  )

  const lastPeerHeartbeats = new Map<string, number>()
  async function loop() {
    const startTime = Date.now()
    const expiredHeartbeatTime = Date.now() - checkHeartbeatInterval

    try {
      for (const [peerId, lastHeartbeat] of lastPeerHeartbeats) {
        if (lastHeartbeat < expiredHeartbeatTime) {
          lastPeerHeartbeats.delete(peerId)
          engine.onPeerDisconnected(peerId)
        }
      }

      const updates = await engine.flush()
      for (const [peerId, update] of updates) {
        if (update.action === 'changeTo') {
          const island = engine.getIsland(update.islandId)!
          logger.debug(`Publishing island change for ${peerId}`)
          publisher.onChangeToIsland(peerId, island, update)
        } else if (update.action === 'leave') {
          // NOTE: we are not sending join/leave messages anymore
        }
      }
      publisher.publishIslandsReport(engine.getIslands())
    } catch (err: any) {
      logger.error(err)
    } finally {
      const flushElapsed = Date.now() - startTime
      setTimeout(loop, Math.max(flushFrequency * 1000 - flushElapsed), 1) // At least 1 ms between flushes
    }
  }

  // NOTE we are using callbacks instead of async, for NATS subscriptions
  // there are some risk associated with this pattern so we should keep the callbacks small and fast
  // see https://github.com/nats-io/nats.js/#async-vs-callbacks
  nats.subscribe('peer.*.connect', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[1]
      engine.onPeerDisconnected(id)
    } catch (err: any) {
      logger.error(`cannot process peer_connect message ${err.message}`)
    }
  })

  nats.subscribe('peer.*.disconnect', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[1]
      engine.onPeerDisconnected(id)
    } catch (err: any) {
      logger.error(`cannot process peer_disconnect message ${err.message}`)
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
      const position = decodedMessage.position!

      lastPeerHeartbeats.set(id, Date.now())
      engine.onPeerPositionsUpdate([
        {
          id,
          position: [position.x, position.y, position.z],
          preferedIslandId: decodedMessage.desiredRoom
        }
      ])
    } catch (err: any) {
      logger.error(`cannot process heartbeat message ${err.message}`)
    }
  })

  loop().catch((err) => logger.error(err))
}
