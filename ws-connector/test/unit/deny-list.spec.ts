import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createDenyListComponent, IDenyListComponent } from '../../src/adapters/deny-list'
import { buildResponse, createFetchMockedComponent } from '../mocks/fetch-mock'

const DENIED = '0xdenied0000000000000000000000000000000001'
const ALLOWED = '0xallowed000000000000000000000000000000001'
const TEST_URL = 'https://example.invalid/denylist.json'

describe('deny list adapter', () => {
  let denyList: IDenyListComponent
  let fetch: ReturnType<typeof createFetchMockedComponent>

  function respondWith(users: unknown): void {
    fetch.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ users })
    } as unknown as Response)
  }

  async function build(): Promise<IDenyListComponent> {
    const config = createConfigComponent({ DENYLIST_JSON_URL: TEST_URL })
    const logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })

    return createDenyListComponent({ config, logs, fetch })
  }

  beforeEach(() => {
    fetch = createFetchMockedComponent()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  describe('when the list contains the address', () => {
    beforeEach(async () => {
      respondWith([{ wallet: DENIED }])
      denyList = await build()
    })

    it('should report it as deny-listed', async () => {
      await expect(denyList.isDenylisted(DENIED)).resolves.toBe(true)
    })

    it('should report a different address as allowed', async () => {
      await expect(denyList.isDenylisted(ALLOWED)).resolves.toBe(false)
    })

    it('should fetch from the configured url', async () => {
      await denyList.isDenylisted(DENIED)

      expect(fetch.fetch).toHaveBeenCalledWith(TEST_URL)
    })
  })

  describe('when the list holds a checksummed address', () => {
    beforeEach(async () => {
      respondWith([{ wallet: DENIED.toUpperCase() }])
      denyList = await build()
    })

    it('should still match the lower-cased form, since callers normalize before asking', async () => {
      await expect(denyList.isDenylisted(DENIED)).resolves.toBe(true)
    })
  })

  describe('when the same address is checked repeatedly', () => {
    beforeEach(async () => {
      respondWith([{ wallet: DENIED }])
      denyList = await build()

      await denyList.isDenylisted(DENIED)
      await denyList.isDenylisted(DENIED)
      await denyList.isDenylisted(ALLOWED)
    })

    it('should fetch once and serve the rest from cache', () => {
      // This runs twice per handshake, so an uncached read would put a network round-trip in
      // front of every connection.
      expect(fetch.fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the fetch fails', () => {
    beforeEach(async () => {
      fetch.fetch.mockRejectedValue(new Error('network error'))
      denyList = await build()
    })

    it('should fail open rather than reject, since this gates the handshake', async () => {
      await expect(denyList.isDenylisted(DENIED)).resolves.toBe(false)
    })

    it('should not retry on every call, which would add a failing round-trip per handshake', async () => {
      // The real defect this guards: if the timestamp only advanced on success, a deny-list
      // outage would make every single handshake pay a failed request.
      await denyList.isDenylisted(DENIED)
      await denyList.isDenylisted(DENIED)
      await denyList.isDenylisted(ALLOWED)

      expect(fetch.fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the fetch returns a non-OK status', () => {
    let response: ReturnType<typeof buildResponse>

    beforeEach(async () => {
      response = buildResponse({ ok: false, status: 503 })
      fetch.fetch.mockResolvedValue(response)
      denyList = await build()
    })

    it('should fail open', async () => {
      await expect(denyList.isDenylisted(DENIED)).resolves.toBe(false)
    })

    it('should release the body it is discarding', async () => {
      await denyList.isDenylisted(DENIED)

      expect(response.body.cancel).toHaveBeenCalled()
    })
  })

  describe('when the payload has no users array', () => {
    beforeEach(async () => {
      respondWith(undefined)
      denyList = await build()
    })

    it('should treat the list as empty rather than throwing', async () => {
      await expect(denyList.isDenylisted(DENIED)).resolves.toBe(false)
    })
  })

  describe('when the TTL has elapsed since the last fetch', () => {
    beforeEach(async () => {
      jest.useFakeTimers()
      respondWith([{ wallet: DENIED }])
      denyList = await build()
      await denyList.isDenylisted(DENIED)

      // Past the 5 minute window.
      jest.setSystemTime(Date.now() + 6 * 60 * 1000)
      respondWith([])
      await denyList.isDenylisted(DENIED)
    })

    it('should refetch', () => {
      expect(fetch.fetch).toHaveBeenCalledTimes(2)
    })

    it('should serve the refreshed list, so a lifted deny takes effect', async () => {
      await expect(denyList.isDenylisted(DENIED)).resolves.toBe(false)
    })
  })
})
