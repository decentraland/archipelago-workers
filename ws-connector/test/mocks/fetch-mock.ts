import { IFetchComponent } from '@dcl/core-commons'

/**
 * Minimal `IFetchComponent` double. Defaults to a 200 with an empty JSON body; pass `overrides`
 * to control a specific response, or override `fetch` outright to reject.
 */
export const createFetchMockedComponent = (
  overrides?: Partial<jest.Mocked<IFetchComponent>>
): jest.Mocked<IFetchComponent> => {
  return {
    fetch: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({})
    }),
    ...overrides
  } as unknown as jest.Mocked<IFetchComponent>
}
