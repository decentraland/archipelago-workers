import { Router } from '@well-known-components/http-server'
import {
  HttpRequest,
  HttpResponse,
  createMetricsHandler,
  onRequestEnd,
  onRequestStart
} from '@well-known-components/uws-http-server'
import { GlobalContext, IHandler } from '../types'
import { createStatusHandler } from './handlers/status-handler'
import { registerWsHandler } from './handlers/ws-handler'

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

  await registerWsHandler(context.components)

  {
    const handler = await createStatusHandler(context.components)
    server.app.get(handler.path, wrap(handler))
  }

  {
    const { path, handler } = await createMetricsHandler(context.components)
    server.app.get(path, handler)
  }

  // TODO: do I need to implement these?
  // *  - GET /health/ready - readyness probe
  // *  - GET /health/startup - startup probe

  server.app.any('/health/live', (res, req) => {
    const { end, labels } = onRequestStart(metrics, req.getMethod(), '/health/live')
    res.writeStatus('200 OK')
    res.writeHeader('Access-Control-Allow-Origin', '*')
    res.end('alive')
    onRequestEnd(metrics, labels, 404, end)
  })

  server.app.any('/*', (res, req) => {
    const { end, labels } = onRequestStart(metrics, req.getMethod(), '')
    res.writeStatus('404 Not Found')
    res.writeHeader('Access-Control-Allow-Origin', '*')
    res.writeHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'Not Found' }))
    onRequestEnd(metrics, labels, 404, end)
  })

  return router
}
