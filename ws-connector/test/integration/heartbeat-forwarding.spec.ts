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
import { NatsMsg } from '@well-known-components/nats-component/dist/types'

/**
 * `HEARTBEAT_FORWARDING_ENABLED=false` is the rollout switch for iteration 2: the client heartbeat
 * stops being republished on NATS once heartbeat-free clients dominate, ahead of the code being
 * deleted. The risk it carries is that the flip takes the session with it — old clients keep
 * sending heartbeats, and the socket exists to deliver `island_changed`.
 *
 * So this drives the real `/ws` route against a real uWebSockets server and a real NATS broker,
 * with the flag off: a real client authenticates, sends a heartbeat, and must still get its island
 * assignment. The unit spec (`test/unit/ws-handler.spec.ts`) pins which subjects are published in
 * either flag state; this one pins that nothing else on the socket noticed.
 */
const { HTTP_SERVER_HOST, HTTP_SERVER_PORT } = defaultServerConfig()

test('heartbeat forwarding disabled', ({ components, beforeStart }) => {
  const identity = createEphemeralIdentity('heartbeat-flag')

  // `test/components.ts` builds the config from `process.env` and `beforeStart` runs before the
  // program is initialized, so this is the seam for handing the handler the flag. Restored
  // afterwards because jest reuses the worker process for the other spec files.
  const overrides: Record<string, string> = {
    HEARTBEAT_FORWARDING_ENABLED: 'false',
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

  describe('when an authenticated client on an old build still sends heartbeats', () => {
    let ws: WebSocket | undefined
    let peerSubjects: string[]
    let delivered: ServerPacket | undefined
    let deliveryError: unknown

    beforeAll(async () => {
      // The flag only means something if the handler actually read it. Read it back through the
      // same `config` component `registerWsHandler` reads, so a `test/components.ts` edit that
      // shadows the env override fails here loudly instead of quietly re-testing the default.
      expect(await components.config.getString('HEARTBEAT_FORWARDING_ENABLED')).toBe('false')

      // Both retired subjects, subscribed separately: the local broker matches `*` per token and
      // requires equal token counts, so there is no one pattern that covers them.
      peerSubjects = []
      const record = (_error: Error | null, message: NatsMsg) => {
        peerSubjects.push(message.subject)
      }
      components.nats.subscribe('peer.*.heartbeat', record)
      components.nats.subscribe('peer.*.disconnect', record)

      const socket = await connectSocket()
      ws = socket.ws

      await socketSend(
        ws,
        ClientPacket.encode({
          message: { $case: 'heartbeat', heartbeat: { position: { x: 1, y: 2, z: 3 } } }
        }).finish()
      )
      await settle()

      components.nats.publish(
        `engine.peer.${socket.address}.island_changed`,
        IslandChangedMessage.encode({
          islandId: 'island-heartbeat-flag',
          connStr: 'livekit:wss://example.com?access_token=jwt',
          peers: {}
        }).finish()
      )

      try {
        delivered = await socket.channel.yield(5000, 'island_changed did not arrive with the flag off')
      } catch (error) {
        deliveryError = error
      }
    })

    afterAll(async () => {
      // Optional-chained: `ws` is only assigned once `connectSocket()` resolves, so a `beforeAll`
      // that fails earlier must not bury the real error under a TypeError from the cleanup.
      ws?.close()
      // The close handler is the other publish site; let it run before the subjects are asserted.
      await settle()
    })

    it('should not republish the heartbeat on NATS', () => {
      expect(peerSubjects).toEqual([])
    })

    it('should still deliver the island assignment, the message the socket exists to carry', () => {
      expect(deliveryError).toBeUndefined()
      expect(delivered?.message?.$case).toBe('islandChanged')
      expect(delivered?.message?.$case === 'islandChanged' && delivered.message.islandChanged.islandId).toBe(
        'island-heartbeat-flag'
      )
    })
  })
})

/** The broker delivers on its own loop, so let it drain before asserting on what arrived. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100))
}

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
