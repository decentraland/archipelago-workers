import { ISupersedeCooldownComponent } from '../../src/adapters/supersede-cooldown'

export const createSupersedeCooldownMockedComponent = (
  overrides?: Partial<jest.Mocked<ISupersedeCooldownComponent>>
): jest.Mocked<ISupersedeCooldownComponent> => {
  // Backed by a real Set so read-your-writes works without every test wiring it up.
  const cooling = new Set<string>()

  return {
    onSuperseded: jest.fn((address: string) => {
      cooling.add(address)
    }),
    isCoolingDown: jest.fn((address: string) => cooling.has(address)),
    size: jest.fn(() => cooling.size),
    ...overrides
  } as unknown as jest.Mocked<ISupersedeCooldownComponent>
}
