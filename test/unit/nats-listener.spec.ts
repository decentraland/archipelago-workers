import { createConfigComponent } from '@well-known-components/env-config-provider'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { createLogComponent } from '@well-known-components/logger'
import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { HeartbeatMessage } from '../../src/controllers/proto/archipelago'
import { setupListener } from '../../src/controllers/listener'
import { PeerPositionChange } from '../../src/types'
import { delay } from '../helpers/archipelago'

describe('nats listener', () => {
  let logs: ILoggerComponent
  let nats: INatsComponent
  let listener: { stop: () => void } | undefined = undefined

  const config = createConfigComponent({
    CHECK_HEARTBEAT_INTERVAL: '100'
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
    const archipelago = {
      clearPeers(...peers: string[]): void {},
      setPeersPositions(..._: PeerPositionChange[]): void {}
    }

    const clearPeersStub = jest.spyOn(archipelago, 'clearPeers')
    listener = await setupListener({ logs, nats, archipelago, config })
    nats.publish('peer.peer1.connect')
    await delay(100)
    expect(clearPeersStub).toHaveBeenCalledWith('peer1')
  })

  it('should listen disconnections and clear peers', async () => {
    const archipelago = {
      clearPeers(..._: string[]): void {},
      setPeersPositions(..._: PeerPositionChange[]): void {}
    }

    const clearPeersStub = jest.spyOn(archipelago, 'clearPeers')
    listener = await setupListener({ logs, nats, archipelago, config })
    nats.publish('peer.peer1.disconnect')
    await delay(100)
    expect(clearPeersStub).toHaveBeenCalledWith('peer1')
  })

  it('should listen hearbeats and set positions', async () => {
    const archipelago = {
      clearPeers(..._: string[]): void {},
      setPeersPositions(..._: PeerPositionChange[]): void {}
    }

    const setPeersPositionsStub = jest.spyOn(archipelago, 'setPeersPositions')
    listener = await setupListener({ logs, nats, archipelago, config })
    nats.publish(
      'client-proto.peer.peer1.heartbeat',
      HeartbeatMessage.encode({
        position: {
          x: 0,
          y: 0,
          z: 0
        }
      }).finish()
    )
    await delay(100)
    expect(setPeersPositionsStub).toHaveBeenCalledWith({
      id: 'peer1',
      position: [0, 0, 0]
    })
  })
})
