import { Router } from '@well-known-components/http-server'
import { GlobalContext } from '../types'
import { parcelsHandler } from './handlers/parcels-handler'
import { peersHandler } from './handlers/peers-handler'
import { islandHandler, islandsHandler } from './handlers/islands-handler'
import { hotScenesHandler } from './handlers/hot-scenes-handler'
import { coreStatusHandler } from './handlers/core-status-handler'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(_: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  router.get('/parcels', parcelsHandler)
  router.get('/peers', peersHandler)
  router.get('/islands', islandsHandler)
  router.get('/islands/:id', islandHandler)
  router.get('/core-status', coreStatusHandler)

  router.get('/hot-scenes', hotScenesHandler)

  return router
}
