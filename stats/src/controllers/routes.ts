import { Router } from '@well-known-components/http-server'
import { GlobalContext } from '../types'
import { parcelsHandler } from './handlers/parcels-handler'
import { peerHandler, peersHandler } from './handlers/peers-handler'
import { islandHandler, islandsHandler } from './handlers/islands-handler'
import { hotScenesHandler } from './handlers/hot-scenes-handler'
import { coreStatusHandler } from './handlers/core-status-handler'
import { statusHandler } from './handlers/status-handler'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(_: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  // NOTE(hugo): we also support /comms prefix for backwards compatibility
  for (const prefix of ['', '/comms']) {
    router.get(prefix + '/parcels', parcelsHandler)
    router.get(prefix + '/peers', peersHandler)
    router.get(prefix + '/peers/:id', peerHandler)
    router.get(prefix + '/islands', islandsHandler)
    router.get(prefix + '/islands/:id', islandHandler)
  }
  router.get('/core-status', coreStatusHandler)
  router.get('/status', statusHandler)

  router.get('/hot-scenes', hotScenesHandler)

  return router
}
