import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { Reader } from 'protobufjs/minimal'
import { IslandStatusMessage } from '../../src/controllers/proto/archipelago'
import { Island } from '../../src/types'
import { setupIslandsStatusReporting } from '../../src/controllers/islands-status-report'
import { createLogComponent } from '@well-known-components/logger'
import { createConfigComponent } from '@well-known-components/env-config-provider'

describe('island-status-reporting', () => {
  it('should publish to NATS', async () => {
    const logs = await createLogComponent({})
    const config = createConfigComponent({})
    const nats = await createLocalNatsComponent()
    const islands: Island[] = [
      {
        id: 'I1',
        center: [0, 0, 0],
        radius: 100,
        maxPeers: 100,
        peers: [],
        sequenceId: 10,
        transport: 'p2p'
      }
    ]

    const s = nats.subscribe('archipelago.islands')

    const archipelago = {
      getIslands: () => Promise.resolve(islands)
    }
    const { publishReport } = await setupIslandsStatusReporting({ nats, logs, config, archipelago })
    await publishReport()

    for await (const message of s.generator) {
      const { data } = IslandStatusMessage.decode(Reader.create(message.data))
      expect(data).toHaveLength(1)
      expect(data).toEqual(
        expect.arrayContaining([
          {
            id: 'I1',
            peers: [],
            maxPeers: 100,
            center: {
              x: 0,
              y: 0,
              z: 0
            },
            radius: 100
          }
        ])
      )
      break
    }
  })
})
