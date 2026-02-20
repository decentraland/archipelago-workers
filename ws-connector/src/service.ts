import {
  IslandChangedMessage,
  ProfileUpdateNotification,
  SceneUpdateNotification
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Lifecycle } from '@well-known-components/interfaces'
import { setupRoutes } from './controllers/routes'
import { craftMessage } from './logic/craft-message'
import { AppComponents, TestComponents } from './types'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  await setupRoutes(components)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, logs, peersRegistry, islandRegistry, parcelTracker } = components

  const logger = logs.getLogger('ws-connector')

  // Handle island changes: forward to local peer + update global island registry
  nats.subscribe('engine.peer.*.island_changed', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const id = message.subject.split('.')[2]
      const islandChanged = IslandChangedMessage.decode(message.data)

      // Update global island registry (all instances see all peers)
      islandRegistry.setPeerIsland(id, islandChanged.islandId)

      // Forward to local peer if connected to this instance
      logger.debug(`publishing island change for ${id}`)
      const ws = peersRegistry.getPeerWs(id)
      if (ws) {
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

  // Handle profile updates: push to all peers on the same island
  nats.subscribe('service.profile_update', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const profileUpdate = ProfileUpdateNotification.decode(message.data)
      const islandId = islandRegistry.getPeerIsland(profileUpdate.address)
      if (!islandId) {
        return
      }

      const peersOnIsland = islandRegistry.getPeersOnIsland(islandId)
      const encoded = craftMessage({
        message: {
          $case: 'profileUpdate',
          profileUpdate
        }
      })

      for (const peer of peersOnIsland) {
        if (peer === profileUpdate.address) {
          continue
        }
        const ws = peersRegistry.getPeerWs(peer)
        if (ws) {
          ws.send(encoded, true)
        }
      }

      logger.debug(`profile update for ${profileUpdate.address} sent to ${peersOnIsland.length - 1} peers on island ${islandId}`)
    } catch (err: any) {
      logger.error(`cannot process profile update message ${err.message}`)
    }
  })

  // Handle scene updates: push to all local peers standing on affected parcels
  nats.subscribe('service.scene_update', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    try {
      const sceneUpdate = SceneUpdateNotification.decode(message.data)
      const affectedPeers = parcelTracker.getPeersOnParcels(sceneUpdate.parcels)

      if (affectedPeers.length === 0) {
        return
      }

      const encoded = craftMessage({
        message: {
          $case: 'sceneUpdate',
          sceneUpdate
        }
      })

      for (const peer of affectedPeers) {
        const ws = peersRegistry.getPeerWs(peer)
        if (ws) {
          ws.send(encoded, true)
        }
      }

      logger.debug(`scene update for ${sceneUpdate.sceneId} sent to ${affectedPeers.length} peers`)
    } catch (err: any) {
      logger.error(`cannot process scene update message ${err.message}`)
    }
  })
}
