import { HeartbeatMessage, Position3DMessage } from '../../src/controllers/proto/archipelago_pb'
import { setupTopics } from '../../src/controllers/topics'
import { IslandUpdates, UpdateSubscriber } from '../../src/logic/archipelago'
import { test } from '../components'
import { untilTrue } from '../helpers/archipelago'

// @ts-ignore
jest.useFakeTimers({ advanceTimers: true })
test('Topics', function ({ components }) {
  let receivedUpdates: IslandUpdates[]
  let subscription: UpdateSubscriber

  beforeEach(() => {
    receivedUpdates = []
    const subscription = (updates) => {
      receivedUpdates.push(updates)
    }
    components.archipelago.subscribeToUpdates(subscription)
  })

  afterEach(() => {
    components.archipelago.unsubscribeFromUpdates(subscription)
  })

  async function receivedUpdatesForPeers(...ids: string[]) {
    await untilTrue(
      () => ids.every((id) => receivedUpdates.some((update) => id in update)),
      `Peers ${ids.join(', ')} should have received updates and they didn't. Received updates: ${JSON.stringify(
        receivedUpdates
      )}`,
      2000
    )
  }

  it('clear inactive peers', async () => {
    const clearPeersSpy = jest.spyOn(components.archipelago, 'clearPeers')

    const peerId = '1'
    const message = new HeartbeatMessage()
    const position = new Position3DMessage()
    position.setX(0)
    position.setY(0)
    position.setZ(0)
    message.setPosition(position)

    components.messageBroker.publish(`peer.${peerId}.heartbeat`, message.serializeBinary())
    components.archipelago.flush()
    await receivedUpdatesForPeers('1')

    expect(clearPeersSpy).toHaveBeenCalledTimes(0)
    const archipelagoHeartbeatInterval = await components.config.requireNumber('CHECK_HEARTBEAT_INTERVAL')
    jest.setSystemTime(Date.now() + archipelagoHeartbeatInterval)
    jest.advanceTimersByTime(archipelagoHeartbeatInterval)
    expect(clearPeersSpy).toHaveBeenCalledTimes(1)
    expect(clearPeersSpy).toHaveBeenLastCalledWith(peerId)
  })
})
