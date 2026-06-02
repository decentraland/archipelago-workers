import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createLivekitTransport } from '../../src/components'

describe('livekit transport ban check', () => {
  const baseConfig = {
    LIVEKIT_API_KEY: 'test-api-key',
    LIVEKIT_API_SECRET: 'test-api-secret-not-less-than-32-bytes-long',
    LIVEKIT_HOST: 'wss://livekit.example'
  }
  const gatekeeperUrl = 'http://comms-gatekeeper.test:5000'

  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = jest.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function buildTransport(extraConfig: Record<string, string> = {}) {
    const config = createConfigComponent({ ...baseConfig, ...extraConfig })
    const logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })
    return createLivekitTransport(config, logs)
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }

  describe('when COMMS_GATEKEEPER_URL is unset', () => {
    it('skips the ban check and mints tokens for every user', async () => {
      const transport = await buildTransport()
      const result = await transport.getConnectionStrings(['0xabc', '0xdef'], 'island-1')

      expect(fetchMock).not.toHaveBeenCalled()
      expect(Object.keys(result)).toEqual(['0xabc', '0xdef'])
    })
  })

  describe('when COMMS_GATEKEEPER_URL is set', () => {
    it('omits banned users from the result and includes non-banned users', async () => {
      fetchMock.mockImplementation((url: string) => {
        const isBanned = url.includes('0xbanned')
        return Promise.resolve(jsonResponse({ data: { isBanned } }))
      })
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings(['0xok', '0xbanned'], 'island-1')

      expect(Object.keys(result).sort()).toEqual(['0xok'])
      expect(result['0xok']).toMatch(/^livekit:/)
    })

    it('URL-encodes the address in the request path', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { isBanned: false } }))
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      // A weird address forces encodeURIComponent to actually do work.
      await transport.getConnectionStrings(['user/with?special#chars'], 'island-1')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const calledUrl = fetchMock.mock.calls[0][0] as string
      expect(calledUrl).toBe(`${gatekeeperUrl}/users/user%2Fwith%3Fspecial%23chars/bans`)
    })

    it('fails open when the gatekeeper returns a non-OK status', async () => {
      fetchMock.mockResolvedValue(new Response('oops', { status: 500 }))
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings(['0xabc'], 'island-1')

      expect(result['0xabc']).toMatch(/^livekit:/)
    })

    it('fails open when the fetch call rejects', async () => {
      fetchMock.mockRejectedValue(new Error('network down'))
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings(['0xabc'], 'island-1')

      expect(result['0xabc']).toMatch(/^livekit:/)
    })

    it('fails open when the response body is malformed', async () => {
      fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings(['0xabc'], 'island-1')

      expect(result['0xabc']).toMatch(/^livekit:/)
    })

    it('returns an empty record when every user is banned', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: { isBanned: true } })))
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings(['0xa', '0xb', '0xc'], 'island-1')

      expect(result).toEqual({})
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('returns an empty record when called with no users', async () => {
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings([], 'island-1')

      expect(result).toEqual({})
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('treats a missing isBanned field as not banned', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: {} }))
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const result = await transport.getConnectionStrings(['0xabc'], 'island-1')

      expect(result['0xabc']).toMatch(/^livekit:/)
    })

    it('caps concurrent ban-check requests', async () => {
      let inFlight = 0
      let observedMaxInFlight = 0
      fetchMock.mockImplementation(() => {
        inFlight++
        observedMaxInFlight = Math.max(observedMaxInFlight, inFlight)
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            inFlight--
            resolve(jsonResponse({ data: { isBanned: false } }))
          }, 5)
        })
      })
      const transport = await buildTransport({ COMMS_GATEKEEPER_URL: gatekeeperUrl })

      const userIds = Array.from({ length: 50 }, (_, i) => `0xuser${i}`)
      await transport.getConnectionStrings(userIds, 'island-1')

      expect(fetchMock).toHaveBeenCalledTimes(50)
      // BAN_CHECK_CONCURRENCY = 20
      expect(observedMaxInFlight).toBeLessThanOrEqual(20)
    })
  })
})
