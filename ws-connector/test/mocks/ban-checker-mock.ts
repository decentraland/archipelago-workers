import { IBanCheckerComponent } from '../../src/adapters/ban-checker'

export const createBanCheckerMockedComponent = (
  overrides?: Partial<jest.Mocked<IBanCheckerComponent>>
): jest.Mocked<IBanCheckerComponent> => {
  return {
    isBanned: jest.fn().mockResolvedValue(false),
    ...overrides
  } as unknown as jest.Mocked<IBanCheckerComponent>
}
