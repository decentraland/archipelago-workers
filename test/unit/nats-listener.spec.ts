import { createConfigComponent } from '@well-known-components/env-config-provider'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { createLogComponent } from '@well-known-components/logger'
import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { Heartbeat } from '../../src/controllers/proto/bff/comms-director-service'
import { setupListener } from '../../src/controllers/listener'
import { PeerPositionChange } from '../../src/types'
import { delay } from '../helpers/archipelago'
import { ArchipelagoController } from '../../src/controllers/archipelago'

describe('nats listener', () => {
  let logs: ILoggerComponent
  let nats: INatsComponent
  let listener: { stop: () => void } | undefined = undefined

  let archipelago: Pick<ArchipelagoController, 'onPeerRemoved' | 'onPeerPositionsUpdate'>

  const config = createConfigComponent({
    CHECK_HEARTBEAT_INTERVAL: '100'
  })

  beforeEach(() => {
    archipelago = {
      onPeerRemoved(_: string): void {},
      onPeerPositionsUpdate(_: PeerPositionChange[]): void {}
    }
  })

  beforeAll(async () => {
    logs = await createLogComponent({})
    nats = await createLocalNatsComponent()
  })

  afterEach(() => {
    if (listener) {
      listener.stop()
    }
  })

  it('should listen connections and clear peers', async () => {
    const onPeerRemovedStub = jest.spyOn(archipelago, 'onPeerRemoved')
    listener = await setupListener(archipelago, { logs, nats, config })
    nats.publish('peer.peer1.connect')
    await delay(100)
    expect(onPeerRemovedStub).toHaveBeenCalledWith('peer1')
  })

  it('should listen disconnections and clear peers', async () => {
    const onPeerRemovedStub = jest.spyOn(archipelago, 'onPeerRemoved')
    listener = await setupListener(archipelago, { logs, nats, config })
    nats.publish('peer.peer1.disconnect')
    await delay(100)
    expect(onPeerRemovedStub).toHaveBeenCalledWith('peer1')
  })

  it('should listen hearbeats and set positions', async () => {
    const onPeerPositionsUpdateStub = jest.spyOn(archipelago, 'onPeerPositionsUpdate')
    listener = await setupListener(archipelago, { logs, nats, config })
    nats.publish(
      'client-proto.peer.peer1.heartbeat',
      Heartbeat.encode({
        position: {
          x: 0,
          y: 0,
          z: 0
        }
      }).finish()
    )
    await delay(100)
    expect(onPeerPositionsUpdateStub).toHaveBeenCalledWith([
      {
        id: 'peer1',
        position: [0, 0, 0]
      }
    ])
  })
})
