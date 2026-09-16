import { ILoggerComponent } from '@well-known-components/interfaces'

/**
 * Returns the *same* mocked logger for every `getLogger` call, so a test can assert on what a
 * component logged without having to know which name it asked for.
 */
export const createLoggerMockedComponent = (
  overrides?: Partial<jest.Mocked<ILoggerComponent.ILogger>>
): jest.Mocked<ILoggerComponent> & { logger: jest.Mocked<ILoggerComponent.ILogger> } => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    ...overrides
  } as unknown as jest.Mocked<ILoggerComponent.ILogger>

  return {
    getLogger: jest.fn().mockReturnValue(logger),
    logger
  } as unknown as jest.Mocked<ILoggerComponent> & { logger: jest.Mocked<ILoggerComponent.ILogger> }
}
