import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createBanChecker, IBanCheckerComponent } from '../../src/adapters/ban-checker'
import { createFetchMockedComponent } from '../mocks/fetch-mock'
import { createLoggerMockedComponent } from '../mocks/logger-mock'

const ADDRESS = '0xbanned0000000000000000000000000000000001'
const GATEKEEPER_URL = 'https://gatekeeper.invalid'

describe('ban checker adapter', () => {
  let banChecker: IBanCheckerComponent
  let fetch: ReturnType<typeof createFetchMockedComponent>
  let logs: ReturnType<typeof createLoggerMockedComponent>

  function respondWith(body: unknown, ok = true, status = 200): void {
    fetch.fetch.mockResolvedValue({ ok, status, json: async () => body } as unknown as Response)
  }

  // Takes the raw config record rather than a url, because passing `undefined` to a parameter
  // with a default silently resolves to the default — which is exactly the not-configured case
  // this spec needs to be able to express.
  async function build(
    values: Record<string, string> = { COMMS_GATEKEEPER_URL: GATEKEEPER_URL }
  ): Promise<IBanCheckerComponent> {
    const config = createConfigComponent(values)
    logs = createLoggerMockedComponent()

    return createBanChecker({ config, logs, fetch })
  }

  beforeEach(() => {
    fetch = createFetchMockedComponent()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('when the gatekeeper reports a ban', () => {
    beforeEach(async () => {
      respondWith({ data: { isBanned: true } })
      banChecker = await build()
    })

    it('should report the address as banned', async () => {
      await expect(banChecker.isBanned(ADDRESS)).resolves.toBe(true)
    })

    it('should ask the gatekeeper about that address', async () => {
      await banChecker.isBanned(ADDRESS)

      expect(fetch.fetch).toHaveBeenCalledWith(`${GATEKEEPER_URL}/users/${ADDRESS}/bans`, expect.anything())
    })

    it('should bound the request so a slow gatekeeper cannot stall the handshake', async () => {
      await banChecker.isBanned(ADDRESS)

      expect(fetch.fetch).toHaveBeenCalledWith(expect.any(String), { signal: expect.any(AbortSignal) })
    })
  })

  describe('when the gatekeeper reports no ban', () => {
    beforeEach(async () => {
      respondWith({ data: { isBanned: false } })
      banChecker = await build()
    })

    it('should report the address as allowed', async () => {
      await expect(banChecker.isBanned(ADDRESS)).resolves.toBe(false)
    })
  })

  describe('when the response body is not the expected shape', () => {
    beforeEach(async () => {
      respondWith({})
      banChecker = await build()
    })

    it('should treat a missing flag as not banned rather than throwing', async () => {
      await expect(banChecker.isBanned(ADDRESS)).resolves.toBe(false)
    })
  })

  describe('when the address contains characters that need escaping', () => {
    beforeEach(async () => {
      respondWith({ data: { isBanned: false } })
      banChecker = await build()
    })

    it('should encode it into the path', async () => {
      await banChecker.isBanned('0x00/../admin')

      expect(fetch.fetch).toHaveBeenCalledWith(
        `${GATEKEEPER_URL}/users/${encodeURIComponent('0x00/../admin')}/bans`,
        expect.anything()
      )
    })
  })

  describe('when the configured url has a trailing slash', () => {
    beforeEach(async () => {
      respondWith({ data: { isBanned: false } })
      banChecker = await build({ COMMS_GATEKEEPER_URL: `${GATEKEEPER_URL}/` })
    })

    it('should not produce a doubled slash in the request', async () => {
      await banChecker.isBanned(ADDRESS)

      expect(fetch.fetch).toHaveBeenCalledWith(`${GATEKEEPER_URL}/users/${ADDRESS}/bans`, expect.anything())
    })
  })

  describe('when the gatekeeper returns a non-OK status', () => {
    beforeEach(async () => {
      respondWith({}, false, 503)
      banChecker = await build()
    })

    it('should fail open, since an outage must not lock everyone out', async () => {
      await expect(banChecker.isBanned(ADDRESS)).resolves.toBe(false)
    })

    it('should log the status it got back', async () => {
      await banChecker.isBanned(ADDRESS)

      expect(logs.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('non-OK status'),
        expect.objectContaining({ status: 503 })
      )
    })
  })

  describe('when the request fails outright', () => {
    beforeEach(async () => {
      fetch.fetch.mockRejectedValue(new Error('ECONNREFUSED'))
      banChecker = await build()
    })

    it('should fail open', async () => {
      await expect(banChecker.isBanned(ADDRESS)).resolves.toBe(false)
    })

    it('should log the reason', async () => {
      await banChecker.isBanned(ADDRESS)

      expect(logs.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Ban check failed'),
        expect.objectContaining({ error: 'ECONNREFUSED' })
      )
    })
  })

  describe('when COMMS_GATEKEEPER_URL is not configured', () => {
    beforeEach(async () => {
      banChecker = await build({})
    })

    it('should skip the check entirely, for local dev', async () => {
      await expect(banChecker.isBanned(ADDRESS)).resolves.toBe(false)
      expect(fetch.fetch).not.toHaveBeenCalled()
    })

    it('should warn at startup that ban checks are disabled', () => {
      expect(logs.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ban checks disabled'))
    })
  })
})
