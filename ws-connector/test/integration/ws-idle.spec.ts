import { wsAsAsyncChannel } from '../helpers/ws-as-async-channel'
import { test } from '../components'
import { createEphemeralIdentity } from '../helpers/identity'
import { defaultServerConfig } from '@dcl/test-helpers'
import { WebSocket } from 'ws'
import { URL } from 'url'
import {
  ChallengeResponseMessage,
  ClientPacket,
  IslandChangedMessage,
  ServerPacket,
  WelcomeMessage
} from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'

/**
 * Iteration 2 removes the client heartbeats that used to be the only traffic on this socket, so
 * from now on nothing but the server's own pings keeps it alive. This drives the real `/ws` route
 * against a real uWebSockets server with a real client that says nothing at all for longer than
 * the idle timeout, and then checks the socket is still usable — an `island_changed` published on
 * NATS still reaches the client.
 *
 * It pins the behaviour, not the option: flip `sendPingsAutomatically` to false in the handler and
 * both cases fail, because the socket is gone before the silence is over.
 *
 * The idle timeout is squeezed to the uWS minimum (8 s, the smallest value it accepts besides 0)
 * so the whole thing takes ~20 s instead of ~100 s.
 */
const IDLE_TIMEOUT_SECONDS = 8
const SILENCE_MS = (IDLE_TIMEOUT_SECONDS + 10) * 1000
const TEST_TIMEOUT_MS = SILENCE_MS + 30 * 1000

// A port of its own: this suite spins up a second uWS server, and jest may run it in parallel
// with the e2e suite, which takes the `.env.default` port.
const { HTTP_SERVER_HOST, HTTP_SERVER_PORT } = defaultServerConfig()

test('idle websocket test', ({ components, beforeStart }) => {
  const identity = createEphemeralIdentity('idle')

  // `test/components.ts` builds the config from `process.env`, and `beforeStart` runs before the
  // program is initialized, so this is the seam for handing the handler a test-sized idle timeout.
  // Restored afterwards because jest reuses the worker process for the other spec files.
  const overrides: Record<string, string> = {
    WS_IDLE_TIMEOUT_SECONDS: String(IDLE_TIMEOUT_SECONDS),
    HTTP_SERVER_HOST,
    HTTP_SERVER_PORT
  }
  const originalEnv = Object.keys(overrides).map((key) => [key, process.env[key]] as const)

  beforeStart(async () => {
    Object.assign(process.env, overrides)
  })
  afterAll(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  async function connectSocket() {
    const url = new URL('/ws', `ws://${HTTP_SERVER_HOST}:${HTTP_SERVER_PORT}`).toString()
    const ws = new WebSocket(url)
    const channel = wsAsAsyncChannel<ServerPacket>(ws, ServerPacket.decode)

    await new Promise<void>((resolve) => ws.on('open', resolve))
    await socketSend(
      ws,
      ClientPacket.encode({
        message: { $case: 'challengeRequest', challengeRequest: { address: identity.address } }
      }).finish()
    )

    const challenge = expectPacket<ChallengeResponseMessage>(
      await channel.yield(5000, 'challenge message did not arrive'),
      'challengeResponse'
    )

    await socketSend(
      ws,
      ClientPacket.encode({
        message: {
          $case: 'signedChallenge',
          signedChallenge: { authChainJson: JSON.stringify(await identity.sign(challenge.challengeToSign)) }
        }
      }).finish()
    )

    const welcome = expectPacket<WelcomeMessage>(await channel.yield(5000, 'welcome message did not arrive'), 'welcome')

    return { ws, channel, address: welcome.peerId }
  }

  describe('when an authenticated client sends nothing for longer than the idle timeout', () => {
    let ws: WebSocket
    let readyStateAfterSilence: number
    let closeCode: number | undefined
    // A dead socket breaks both guarantees at once, so the delivery failure is captured rather
    // than thrown: each case then reports the half it is responsible for.
    let delivered: ServerPacket | undefined
    let deliveryError: unknown

    beforeAll(async () => {
      const socket = await connectSocket()
      ws = socket.ws
      ws.on('close', (code) => {
        closeCode = code
      })

      // The point of the test: no client traffic whatsoever, for longer than the idle timeout.
      await new Promise((resolve) => setTimeout(resolve, SILENCE_MS))
      readyStateAfterSilence = ws.readyState

      components.nats.publish(
        `engine.peer.${socket.address}.island_changed`,
        IslandChangedMessage.encode({
          islandId: 'island-idle',
          connStr: 'livekit:wss://example.com?access_token=jwt',
          peers: {}
        }).finish()
      )

      try {
        delivered = await socket.channel.yield(5000, 'island_changed did not arrive after the silent period')
      } catch (error) {
        deliveryError = error
      }
    }, TEST_TIMEOUT_MS)

    afterAll(() => {
      ws.close()
    })

    it('should still be connected, because the server pings it instead of waiting to be spoken to', () => {
      expect(readyStateAfterSilence).toBe(WebSocket.OPEN)
      expect(closeCode).toBeUndefined()
    })

    it('should still receive its island assignment, the message the socket exists to carry', () => {
      expect(deliveryError).toBeUndefined()
      expect(delivered?.message?.$case).toBe('islandChanged')
      expect(delivered?.message?.$case === 'islandChanged' && delivered.message.islandChanged.islandId).toBe(
        'island-idle'
      )
    })
  })
})

function expectPacket<T>(packet: ServerPacket, packetType: string): T {
  if (!packet.message || packet.message.$case !== packetType) {
    throw new Error(`Expected packet type ${packetType} but got ${packet.message?.$case}`)
  }

  return (packet.message as never)[packetType]
}

function socketSend(socket: WebSocket, message: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(message, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
