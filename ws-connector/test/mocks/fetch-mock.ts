import { IFetchComponent } from '@dcl/core-commons'

/**
 * Minimal `IFetchComponent` double. Defaults to a 200 with an empty JSON body; pass `overrides`
 * to control a specific response, or override `fetch` outright to reject.
 */
export const createFetchMockedComponent = (
  overrides?: Partial<jest.Mocked<IFetchComponent>>
): jest.Mocked<IFetchComponent> => {
  return {
    fetch: jest.fn().mockResolvedValue(buildResponse()),
    ...overrides
  } as unknown as jest.Mocked<IFetchComponent>
}

/**
 * Builds a response double with a cancellable `body`. Callers that discard a response without
 * reading it must cancel the body — an unconsumed undici body pins its socket until GC — so the
 * double carries one in order to make that assertable.
 */
export const buildResponse = ({
  ok = true,
  status = 200,
  body = {}
}: { ok?: boolean; status?: number; body?: unknown } = {}): Response & { body: { cancel: jest.Mock } } => {
  return {
    ok,
    status,
    json: async () => body,
    body: { cancel: jest.fn().mockResolvedValue(undefined) }
  } as unknown as Response & { body: { cancel: jest.Mock } }
}
