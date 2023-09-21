import { peersHandler } from '../../src/controllers/handlers/peers-handler'
import { createStatsComponent } from '../../src/adapters/stats'
import { statusHandler } from '../../src/controllers/handlers/status-handler'

describe('status-handler-unit', () => {
  it('ok', async () => {
    const url = new URL('https://localhost/status')
    const config = {
      getString: async (key: string) => {
        switch (key) {
          case 'COMMIT_HASH':
            return 'commitHash'
          case 'CURRENT_VERSION':
            return 'version'
          default:
            return 'bad'
        }
      },
      getNumber: jest.fn().mockResolvedValue(0),
      requireString: jest.fn().mockResolvedValue(''),
      requireNumber: jest.fn().mockResolvedValue(0)
    }
    const status = await statusHandler({ url, components: { config } })
    expect(status.body.commitHash).toEqual('commitHash')
    expect(status.body.currentTime).toBeGreaterThan(0)
    expect(status.body.version).toEqual('version')
  })
})
