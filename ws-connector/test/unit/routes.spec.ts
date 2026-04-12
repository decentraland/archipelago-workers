import { onRequestEnd, onRequestStart } from '@well-known-components/uws-http-server'
import { setupRoutes } from '../../src/controllers/routes'

jest.mock('../../src/controllers/handlers/ws-handler', () => ({
  registerWsHandler: jest.fn()
}))

jest.mock('../../src/controllers/handlers/status-handler', () => ({
  createStatusHandler: jest.fn().mockResolvedValue({
    path: '/status',
    f: jest.fn().mockResolvedValue({ body: { ok: true } })
  })
}))

jest.mock('@well-known-components/uws-http-server', () => ({
  createMetricsHandler: jest.fn().mockResolvedValue({ path: '/metrics', handler: jest.fn() }),
  onRequestStart: jest.fn().mockReturnValue({ labels: {}, end: 0 }),
  onRequestEnd: jest.fn()
}))

type RouteHandler = (res: any, req: any) => any

function createMockComponents(overrides: { handlerFn?: () => Promise<any> } = {}) {
  const registeredRoutes: Record<string, RouteHandler> = {}

  const mockRes = {
    writeStatus: jest.fn().mockReturnThis(),
    writeHeader: jest.fn().mockReturnThis(),
    end: jest.fn(),
    onAborted: jest.fn()
  }

  const mockReq = {
    getMethod: jest.fn().mockReturnValue('GET')
  }

  const logs = {
    getLogger: jest.fn().mockReturnValue({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn()
    })
  }

  const metrics = {
    registry: {}
  }

  const server = {
    app: {
      ws: jest.fn(),
      get: jest.fn((path: string, handler: RouteHandler) => {
        registeredRoutes[`GET ${path}`] = handler
      }),
      any: jest.fn((path: string, handler: RouteHandler) => {
        registeredRoutes[`ANY ${path}`] = handler
      })
    }
  }

  const components = {
    config: { getString: jest.fn().mockResolvedValue(''), getNumber: jest.fn().mockResolvedValue(0) },
    logs,
    server,
    metrics,
    nats: { subscribe: jest.fn(), publish: jest.fn() },
    peersRegistry: { getPeerCount: jest.fn().mockReturnValue(0) },
    ethereumProvider: {},
    fetch: { fetch: jest.fn() }
  }

  return { components, registeredRoutes, mockRes, mockReq, logs }
}

describe('routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('/health/live', () => {
    it('should report status 200 in metrics', async () => {
      const { components, registeredRoutes, mockRes, mockReq } = createMockComponents()

      await setupRoutes(components as any)

      const healthHandler = registeredRoutes['ANY /health/live']
      expect(healthHandler).toBeDefined()

      await healthHandler(mockRes, mockReq)

      expect(mockRes.writeStatus).toHaveBeenCalledWith('200 OK')
      expect(onRequestEnd).toHaveBeenCalledWith(
        components.metrics,
        expect.anything(),
        200,
        expect.anything()
      )
    })
  })

  describe('wrap error handling', () => {
    it('should log errors when a handler throws', async () => {
      const { components, registeredRoutes, mockRes, mockReq, logs } = createMockComponents()

      await setupRoutes(components as any)

      const statusHandler = registeredRoutes['GET /status']
      expect(statusHandler).toBeDefined()

      // Make onRequestStart return fresh mocks for this call
      const mockEnd = jest.fn()
      ;(onRequestStart as jest.Mock).mockReturnValue({ labels: {}, end: mockEnd })

      // Make the status handler mock throw
      const { createStatusHandler } = require('../../src/controllers/handlers/status-handler')
      const handlerMock = createStatusHandler.mock.results[0].value
      const resolvedHandler = await handlerMock
      resolvedHandler.f.mockRejectedValueOnce(new Error('test error'))

      await statusHandler(mockRes, mockReq)

      const logger = logs.getLogger.mock.results[0].value
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('test error'))
      expect(mockRes.writeStatus).toHaveBeenCalledWith('500')
      expect(mockRes.end).toHaveBeenCalled()
    })
  })
})
