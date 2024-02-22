import { wsAsAsyncChannel } from '../helpers/ws-as-async-channel'
import { test } from '../components'
import { createEphemeralIdentity } from '../helpers/identity'
import { future } from 'fp-future'
import { WebSocket } from 'ws'
import { URL } from 'url'
import {
  ChallengeResponseMessage,
  ClientPacket,
  ServerPacket,
  WelcomeMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'

function expectPacket<T>(packet: ServerPacket, packetType: string): T {
  if (!packet.message || packet.message.$case !== packetType) {
    throw new Error(`Expected packet type ${packetType} but got ${packet.message.$case}`)
  }

  return packet.message[packetType]
}

test('end to end test', ({ components }) => {
  const aliceIdentity = createEphemeralIdentity('alice')
  const bobIdentity = createEphemeralIdentity('bob')

  async function createWs(relativeUrl: string): Promise<WebSocket> {
    const protocolHostAndProtocol = `ws://${await components.config.requireString(
      'HTTP_SERVER_HOST'
    )}:${await components.config.requireNumber('HTTP_SERVER_PORT')}`
    const url = new URL(relativeUrl, protocolHostAndProtocol).toString()
    return new WebSocket(url)
  }

  async function connectSocket(identity: ReturnType<typeof createEphemeralIdentity>) {
    const ws = await createWs('/ws')
    const channel = wsAsAsyncChannel<ServerPacket>(ws, ServerPacket.decode)

    await socketConnected(ws)
    await socketSend(
      ws,
      ClientPacket.encode({
        message: {
          $case: 'challengeRequest',
          challengeRequest: { address: identity.address }
        }
      }).finish()
    )

    // get the challenge from the server
    let packet = await channel.yield(0, 'challenge message did not arrive for ' + identity.address)

    const challengeMessage = expectPacket<ChallengeResponseMessage>(packet, 'challengeResponse')

    // sign the challenge
    const authChainJson = JSON.stringify(await identity.sign(challengeMessage.challengeToSign))
    await socketSend(
      ws,
      ClientPacket.encode({
        message: {
          $case: 'signedChallenge',
          signedChallenge: { authChainJson }
        }
      }).finish()
    )

    // expect welcome message from server
    packet = await channel.yield(0, 'welcome message did not arrive for ' + identity.address)
    const welcomeMessage = expectPacket<WelcomeMessage>(packet, 'welcome')
    return Object.assign(ws, { welcomeMessage, channel, identity, challengeMessage, authChainJson })
  }

  it('connecting one socket and sending nothing should disconnect it after one second', async () => {
    const ws = await createWs('/ws')
    const fut = futureWithTimeout(3000, 'The socket was not closed')

    ws.on('close', fut.resolve) // resolve on close
    ws.on('message', fut.reject) // fail on timeout and message

    await fut
  })

  it('connecting one socket and sending noise should disconnect it immediately', async () => {
    const ws = await createWs('/ws')
    const fut = futureWithTimeout(3000, 'The socket was not closed')

    ws.on('close', (code, reason) => {
      fut.resolve({ code, reason: reason.toString() })
    })
    ws.on('message', fut.reject) // fail on timeout and message

    await socketConnected(ws)
    await socketSend(ws, new Uint8Array([1, 2, 3, 4, 5, 6]))
    const { code, reason } = await fut
    expect(code).toEqual(1007)
    expect(reason).toEqual('Cannot decode ClientPacket')
  })

  it('sends different address', async () => {
    const ws = await createWs('/ws')
    const channel = wsAsAsyncChannel<ServerPacket>(ws, ServerPacket.decode)

    await socketConnected(ws)
    await socketSend(
      ws,
      ClientPacket.encode({
        message: {
          $case: 'challengeRequest',
          challengeRequest: { address: bobIdentity.address }
        }
      }).finish()
    )

    // get the challenge from the server
    let packet = await channel.yield(0, 'challenge message did not arrive for ' + bobIdentity.address)

    const challengeMessage = expectPacket<ChallengeResponseMessage>(packet, 'challengeResponse')

    // sign the challenge
    const authChainJson = JSON.stringify(await aliceIdentity.sign(challengeMessage.challengeToSign))
    await socketSend(
      ws,
      ClientPacket.encode({
        message: {
          $case: 'signedChallenge',
          signedChallenge: { authChainJson }
        }
      }).finish()
    )

    // expect welcome message from server
    packet = await channel.yield(0, 'welcome message did not arrive for ' + aliceIdentity.address)
    const welcomeMessage = expectPacket<WelcomeMessage>(packet, 'welcome')
    expect(welcomeMessage.peerId).toEqual(aliceIdentity.address.toLowerCase())
    ws.close()
  })

  it('connects the websocket and authenticates', async () => {
    const ws = await connectSocket(aliceIdentity)
    ws.close()
  })

  it('connects the websocket and authenticates, doing it twice disconnects former connection', async () => {
    const ws1 = await connectSocket(aliceIdentity)
    const ws2 = await connectSocket(aliceIdentity)

    const ws1DisconnectPromise = futureWithTimeout(1000, 'Socket did not disconnect')
    ws1.on('close', ws1DisconnectPromise.resolve)

    // connect ws2 should say "alreadyConnected=true"
    expect(ws2.challengeMessage.alreadyConnected).toEqual(true)

    const packet = await ws1.channel.yield(100, 'wait for kicked message')
    expect(packet.message.$case).toEqual('kicked')

    // await for disconnection of ws1
    await ws1DisconnectPromise

    // cleanup
    ws2.close()
  })

  it.skip(
    'two peers should be asigned to the same island and receive the appropiate messages',
    async () => {
      const ws1 = await connectSocket(aliceIdentity)
      const ws2 = await connectSocket(bobIdentity)

      const heartbeat = ClientPacket.encode({
        message: {
          $case: 'heartbeat',
          heartbeat: {
            position: {
              x: 0,
              y: 0,
              z: 0
            }
          }
        }
      }).finish()

      await socketSend(ws1, heartbeat)
      const aliceIslandChanged = await ws1.channel.yield(10000, 'wait for alice change island message')
      expect(aliceIslandChanged.message.$case).toEqual('islandChanged')
      if (aliceIslandChanged.message.$case !== 'islandChanged') {
        return
      }

      await socketSend(ws2, heartbeat)
      const bobIslandChanged = await ws2.channel.yield(10000, 'wait for bob change island message')
      expect(bobIslandChanged.message.$case).toEqual('islandChanged')
      if (bobIslandChanged.message.$case !== 'islandChanged') {
        return
      }

      expect(aliceIslandChanged.message.islandChanged.islandId).toEqual(bobIslandChanged.message.islandChanged.islandId)

      const peerJoin = await ws1.channel.yield(100, 'wait for alice to be notified about bob joining the island')
      expect(peerJoin.message.$case).toEqual('joinIsland')

      ws1.close()

      const peerLeft = await ws2.channel.yield(10000, 'wait for bob to be notified about alice leaving the island')
      expect(peerLeft.message.$case).toEqual('leftIsland')

      ws2.close()
    },
    60 * 1000
  )
})

function socketConnected(socket: WebSocket): Promise<void> {
  return new Promise((res) => socket.on('open', res))
}

function socketSend(socket: WebSocket, message: Uint8Array): Promise<void> {
  return new Promise((res, rej) => {
    socket.send(message, (err) => {
      if (err) rej(err)
      else res()
    })
  })
}

function futureWithTimeout<T = any>(ms: number, message = 'Timed out') {
  const fut = future<T>()
  const t = setTimeout(() => fut.reject(new Error(message)), ms)
  fut.finally(() => clearTimeout(t))
  return fut
}
