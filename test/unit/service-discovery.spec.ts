import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { IslandStatusMessage } from '../../src/controllers/proto/archipelago'
import { Island, ServiceDiscoveryMessage } from '../../src/types'
import { setupServiceDiscovery } from '../../src/controllers/service-discovery'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { JSONCodec } from '@well-known-components/nats-component'

describe('service-discovery', () => {
  it('should publish to NATS', async () => {
    const now = Date.now()
    Date.now = jest.fn(() => now)

    const commitHash = '1234456'
    const nats = await createLocalNatsComponent()
    const config = createConfigComponent({
      COMMIT_HASH: commitHash
    })
    const logs = await createLogComponent({})

    const jsonCodec = JSONCodec()
    const s = nats.subscribe('service.discovery')

    const { publishServiceDiscovery } = await setupServiceDiscovery({ nats, logs, config })

    publishServiceDiscovery()

    for await (const message of s.generator) {
      const data: ServiceDiscoveryMessage = jsonCodec.decode(message.data) as any
      expect(data).toEqual(
        expect.objectContaining({
          serverName: 'archipelago',
          status: {
            currentTime: now,
            commitHash
          }
        })
      )
      break
    }
  })
})
