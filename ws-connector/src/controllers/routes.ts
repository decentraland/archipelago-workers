import { Router } from '@well-known-components/http-server'
import { createMetricsHandler, onRequestEnd, onRequestStart } from '@well-known-components/uws-http-server'
import { GlobalContext, IHandler } from '../types'
import { createStatusHandler } from './handlers/status-handler'
import { registerWsHandler } from './handlers/ws-handler'
import { HttpRequest, HttpResponse } from 'uWebSockets.js'

// We return the entire router because it will be easier to test than a whole server
export async function setupRoutes(context: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()
  const { metrics, server } = context.components

  function wrap(h: IHandler) {
    return async (res: HttpResponse, req: HttpRequest) => {
      const { labels, end } = onRequestStart(metrics, req.getMethod(), h.path)
      let status = 500
      try {
        const result = await h.f(res, req)
        status = result.status ?? 200
        res.writeStatus(`${status}`)

        const headers = new Headers(result.headers ?? {})

        if (!headers.has('Access-Control-Allow-Origin')) {
          headers.set('Access-Control-Allow-Origin', '*')
        }

        headers.forEach((v, k) => res.writeHeader(k, v))

        if (result.body === undefined) {
          res.end()
        } else if (typeof result.body === 'string') {
          res.end(result.body)
        } else {
          res.writeHeader('content-type', 'application/json')
          res.end(JSON.stringify(result.body))
        }
      } catch (err) {
        res.writeStatus(`${status}`)
        res.end()
      } finally {
        onRequestEnd(metrics, labels, status, end)
      }
    }
  }

  // TODO
  // *  - GET /health/ready - readyness probe
  // *  - GET /health/startup - startup probe
  // *  - GET /health/live - liveness probe

  registerWsHandler(context.components)

  {
    const handler = await createStatusHandler(context.components)
    server.app.get(handler.path, wrap(handler))
  }

  {
    const { path, handler } = await createMetricsHandler(context.components)
    server.app.get(path, handler)
  }

  return router
}
