import { Router } from '@well-known-components/http-server'
import { GlobalContext } from '../types'
import { pingHandler } from './handlers/ping-handler'
import { transportHandler } from './handlers/transport-handler'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter({ components: { logs, config } }: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()
  const secret = await config.getString('TRANSPORT_REGISTRATION_SECRET')
  const logger = logs.getLogger('router')

  router.get('/ping', pingHandler)
  if (secret) {
    router.get('/transport-registration', transportHandler)
  } else {
    logger.warn('Transport registration is disabled because no secret is defined')
  }

  return router
}
