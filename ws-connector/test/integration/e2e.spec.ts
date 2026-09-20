import { wsAsAsyncChannel } from '../helpers/ws-as-async-channel'
import { test } from '../components'
import { createEphemeralIdentity } from '../helpers/identity'
import { CLOSE_TRY_AGAIN_LATER, SendResult } from '../../src/logic/websocket'
import { future } from 'fp-future'
import { WebSocket } from 'ws'
import { URL } from 'url'
import {
  ChallengeResponseMessage,
  ClientPacket,
  IslandChangedMessage,
  ServerPacket,
  WelcomeMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'

function expectPacket<T>(packet: ServerPacket, packetType: string): T {
  if (!packet.message || packet.message.$case !== packetType) {
    throw new Error(`Expected packet type ${packetType} but got ${packet.message.$case}`)
  }

  return packet.message[packetType]
}

test('end to end test', ({ components, stubComponents }) => {
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

  it('should disconnect a socket that sends nothing after one second', async () => {
    const ws = await createWs('/ws')
    const fut = futureWithTimeout(3000, 'The socket was not closed')

    ws.on('close', fut.resolve) // resolve on close
    ws.on('message', fut.reject) // fail on timeout and message

    await fut
  })

  it('should disconnect a socket that sends noise immediately', async () => {
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

  it('should welcome the authenticated address, not the claimed one', async () => {
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

  it('should complete the handshake and welcome the peer', async () => {
    const ws = await connectSocket(aliceIdentity)
    ws.close()
  })

  it('should kick the former connection when the same identity connects twice', async () => {
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

  it('should keep both sockets when the same wallet connects from a second device', async () => {
    const laptopIdentity = createEphemeralIdentity('alice', 'laptop')
    const desktop = await connectSocket(aliceIdentity)
    const laptop = await connectSocket(laptopIdentity)

    expect(laptop.challengeMessage.alreadyConnected).toEqual(true)

    // The desktop must receive nothing: no kick, no close.
    await expect(desktop.channel.yield(300, 'nothing expected')).rejects.toThrow()

    desktop.close()
    laptop.close()
  })

  describe('when native backpressure drops an island assignment', () => {
    // Frames four times the default maxBackpressure, so the first frame the kernel's send buffer
    // will not take cannot be queued either and is dropped outright. How many frames the kernel
    // absorbs first is decided by its TCP buffer autotuning on the server and the paused client,
    // not by anything in this repo, so the loop runs until the drop is observed, bounded only far
    // enough out (64 MiB) that a runner with generous buffers still gets there.
    const FLOOD_FRAME_BYTES = 4 * 64 * 1024
    const MAX_FLOOD_FRAMES = 256
    const aliceSession = aliceIdentity.ephemeralAddress.toLowerCase()
    const aliceAddress = aliceIdentity.address.toLowerCase()

    let desktop: Awaited<ReturnType<typeof connectSocket>> | undefined
    let laptop: Awaited<ReturnType<typeof connectSocket>> | undefined
    let replacement: Awaited<ReturnType<typeof connectSocket>> | undefined
    let sendResults: number[]
    let droppedIsland: string
    let closeCode: number
    let connectedSessions: string[]
    let connectSubscription: ReturnType<typeof components.nats.subscribe>
    let registryWasCleared: boolean

    function publishIslandChanged(session: string, islandId: string, connStr: string): void {
      components.nats.publish(
        `engine.peer.${aliceAddress}.island_changed.${session}`,
        IslandChangedMessage.encode({ islandId, connStr, peers: {} }).finish()
      )
    }

    beforeEach(async () => {
      desktop = undefined
      laptop = undefined
      replacement = undefined
      sendResults = []
      connectedSessions = []
      droppedIsland = ''
      registryWasCleared = false
      jest.spyOn(components.metrics, 'increment')
      connectSubscription = components.nats.subscribe(`peer.${aliceAddress}.connect`, (error, message) => {
        if (error) throw error
        connectedSessions.push(Buffer.from(message.data).toString('utf8'))
      })
      desktop = await connectSocket(aliceIdentity)
      laptop = await connectSocket(createEphemeralIdentity('alice', 'backpressure-laptop'))
      const desktopClosed = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Backpressured socket did not close')), 5000)
        desktop?.once('close', (code) => {
          clearTimeout(timeout)
          resolve(code)
        })
      })

      // Pause actual TCP reads, then fill bounded native send buffers with valid packets.
      // No mocked send result or close callback: production forwarding must observe uWS's drop.
      desktop.pause()
      const socket = components.peersRegistry.getPeerWs(aliceAddress, aliceSession)
      if (!socket) throw new Error('Authenticated socket was not registered')
      const send = socket.send.bind(socket)
      jest.spyOn(socket, 'send').mockImplementation((...args) => {
        const result = send(...args)
        sendResults.push(result)
        return result
      })
      for (let attempt = 0; attempt < MAX_FLOOD_FRAMES && !sendResults.includes(SendResult.DROPPED); attempt++) {
        droppedIsland = `backpressure-${attempt}`
        publishIslandChanged(aliceSession, droppedIsland, 'x'.repeat(FLOOD_FRAME_BYTES))
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      registryWasCleared = !components.peersRegistry.getPeerWs(aliceAddress, aliceSession)
      desktop.resume()
      if (!sendResults.includes(SendResult.DROPPED)) {
        throw new Error(`Native backpressure limit was not reached within ${MAX_FLOOD_FRAMES} frames`)
      }
      closeCode = await desktopClosed
      // Two handshakes, the flood, the close wait and, in the nested contexts, a third handshake
      // and delivery waits: well past Jest's 5 s default, which would otherwise pre-empt the close
      // timeout above and report a generic hook timeout instead of its message.
    }, 20_000)

    afterEach(() => {
      desktop?.resume()
      desktop?.terminate()
      laptop?.terminate()
      replacement?.terminate()
      connectSubscription?.unsubscribe()
      jest.restoreAllMocks()
    })

    it('should close the dropped socket with the retry code, or abnormally when the close frame is dropped too', () => {
      // Explorer reconnects for both the requested retry code and an abnormal transport close.
      expect([CLOSE_TRY_AGAIN_LATER, 1006]).toContain(closeCode)
    })

    it('should clear the registry entry synchronously from the close', () => {
      expect(registryWasCleared).toBe(true)
    })

    it("should leave the other device's socket open", () => {
      expect(laptop?.readyState).toBe(WebSocket.OPEN)
    })

    it('should count the forced close', () => {
      expect(components.metrics.increment).toHaveBeenCalledWith('dcl_ws_connector_island_changed_dropped_close_total')
    })

    describe('and the same device reconnects with its previous key', () => {
      let recoveredPacket: ServerPacket

      beforeEach(async () => {
        // A second real signed handshake, not a manually inserted registry entry.
        replacement = await connectSocket(aliceIdentity)
        publishIslandChanged(aliceSession, droppedIsland, 'fresh-recovery-token')
        recoveredPacket = await replacement.channel.yield(2000, 'Fresh assignment did not reach replacement socket')
      }, 10_000)

      it('should announce the session again so comms-gatekeeper re-mints for it', () => {
        expect(connectedSessions.filter((session) => session === aliceSession)).toHaveLength(2)
      })

      it('should deliver fresh credentials for the same island without deduplicating them', () => {
        expect(recoveredPacket.message).toMatchObject({
          $case: 'islandChanged',
          islandChanged: { islandId: droppedIsland, connStr: 'fresh-recovery-token' }
        })
      })
    })

    describe('and the device reconnects with a fresh ephemeral key, as Explorer does', () => {
      const recoveryIdentity = createEphemeralIdentity('alice', 'recovery-device')
      const recoverySession = recoveryIdentity.ephemeralAddress.toLowerCase()
      let firstPacket: ServerPacket

      beforeEach(async () => {
        replacement = await connectSocket(recoveryIdentity)
        // Back to back, and delivery is in publish order: were the frame addressed to the dead
        // session forwarded, it would be the first packet the new socket sees.
        publishIslandChanged(aliceSession, droppedIsland, 'token-for-a-dead-session')
        publishIslandChanged(recoverySession, droppedIsland, 'token-for-the-new-session')
        firstPacket = await replacement.channel.yield(2000, 'Assignment did not reach the new session')
      }, 10_000)

      it('should announce the new session on connect', () => {
        expect(connectedSessions).toContain(recoverySession)
      })

      it('should deliver only the assignment addressed to the new session', () => {
        expect(firstPacket.message).toMatchObject({
          $case: 'islandChanged',
          islandChanged: { islandId: droppedIsland, connStr: 'token-for-the-new-session' }
        })
      })

      it('should count the dead-session assignment as a miss, since this replica still holds the wallet', () => {
        expect(components.metrics.increment).toHaveBeenCalledWith(
          'dcl_ws_connector_island_changed_no_session_socket_total'
        )
      })
    })
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

  // These two drive the real handshake against the real handler. They replace unit "tests" that
  // re-implemented the deny-list and platform-ban branches inside the spec file and so passed
  // regardless of what ws-handler.ts actually did.
  describe('when the authenticated address is deny-listed', () => {
    beforeEach(() => {
      // Denies alice only. Bob's claimed address still passes the pre-auth check, so this
      // exercises the post-auth check specifically — the bypass the guard exists for.
      stubComponents.denyList.isDenylisted.mockImplementation(
        async (address: string) => address === aliceIdentity.address.toLowerCase()
      )
    })

    it('should close the socket instead of sending welcome, even when a clean address was claimed', async () => {
      const ws = await createWs('/ws')
      const channel = wsAsAsyncChannel<ServerPacket>(ws, ServerPacket.decode)
      const closed = futureWithTimeout(5000, 'The socket was not closed for the deny-listed wallet')
      ws.on('close', closed.resolve)

      await socketConnected(ws)
      await socketSend(
        ws,
        ClientPacket.encode({
          message: { $case: 'challengeRequest', challengeRequest: { address: bobIdentity.address } }
        }).finish()
      )

      const packet = await channel.yield(0, 'challenge message did not arrive')
      const challengeMessage = expectPacket<ChallengeResponseMessage>(packet, 'challengeResponse')

      await socketSend(
        ws,
        ClientPacket.encode({
          message: {
            $case: 'signedChallenge',
            signedChallenge: {
              authChainJson: JSON.stringify(await aliceIdentity.sign(challengeMessage.challengeToSign))
            }
          }
        }).finish()
      )

      await closed
      ws.close()
    })
  })

  describe('when the authenticated address is platform banned', () => {
    beforeEach(() => {
      stubComponents.banChecker.isBanned.mockResolvedValue(true)
    })

    it('should close the socket instead of sending welcome', async () => {
      const ws = await createWs('/ws')
      const channel = wsAsAsyncChannel<ServerPacket>(ws, ServerPacket.decode)
      const closed = futureWithTimeout(5000, 'The socket was not closed for the banned wallet')
      ws.on('close', closed.resolve)

      await socketConnected(ws)
      await socketSend(
        ws,
        ClientPacket.encode({
          message: { $case: 'challengeRequest', challengeRequest: { address: aliceIdentity.address } }
        }).finish()
      )

      const packet = await channel.yield(0, 'challenge message did not arrive')
      const challengeMessage = expectPacket<ChallengeResponseMessage>(packet, 'challengeResponse')

      await socketSend(
        ws,
        ClientPacket.encode({
          message: {
            $case: 'signedChallenge',
            signedChallenge: {
              authChainJson: JSON.stringify(await aliceIdentity.sign(challengeMessage.challengeToSign))
            }
          }
        }).finish()
      )

      await closed
      ws.close()
    })
  })
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
