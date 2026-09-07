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
 * So this drives the real `/ws` route against a real uWebSockets server and a real NATS broker: a
 * real client authenticates, sends a heartbeat, closes, and must still get its island assignment.
 * Both publish sites are inside the window that gets asserted — the heartbeat one and the close
 * one — which is why the socket is closed in `beforeAll` rather than `afterAll`.
 *
 * **Both flag states run here, and the on state is not optional.** With the flag off the assertion
 * is that no `peer.<addr>.*` subject arrived, and an empty list is also what you get when the
 * heartbeat never reaches the publish site at all: `handlers.message` decodes inside a `try` and
 * silently ignores a packet that does not resolve to `$case === 'heartbeat'`. So a `ClientPacket`
 * field renumber, an encode change, or an edit to this file's own `socketSend` payload would leave
 * the off-state program green while proving nothing about the flag. The on-state programs are what
 * pin that the heartbeat travels the real wire and lands on `peer.<addr>.heartbeat`, and that a
 * real uWS `close` still produces `peer.<addr>.disconnect` — the guarantee whose failure mode is
 * archipelago-stats' peer map growing without bound. The unit spec
 * (`test/unit/ws-handler.spec.ts`) covers the rest of the value vocabulary against a stubbed nats.
 *
 * One program per flag state, each with its own server: `defaultServerConfig()` bumps a
 * module-level port counter on every call, so a second and third call cost nothing but a port.
 */

/** The flag off: neither retired subject is published, and the session survives. */
heartbeatForwardingProgram({
  suiteName: 'heartbeat forwarding disabled',
  flagValue: 'false',
  expectedConfigValue: 'false',
  republishes: false
})

/** The flag explicitly on: today's behaviour, end to end. */
heartbeatForwardingProgram({
  suiteName: 'heartbeat forwarding enabled explicitly',
  flagValue: 'true',
  expectedConfigValue: 'true',
  republishes: true
})

/**
 * Nothing set in the environment. `initComponents` loads `.env.default` through
 * `createDotEnvConfigComponent`, which copies the keys it parses into `process.env` for any key
 * the environment does not already carry — so this program also pins that the value
 * `ws-connector/.env.default` ships is one that keeps forwarding on. A truly empty config (no
 * env, no file) is the unit spec's `is left unset` case; it is not reachable from here.
 */
heartbeatForwardingProgram({
  suiteName: 'heartbeat forwarding left to the shipped default',
  flagValue: undefined,
  expectedConfigValue: 'true',
  republishes: true
})

type HeartbeatForwardingProgram = {
  suiteName: string
  /** What to put in `process.env`, or `undefined` to delete the key before the program starts. */
  flagValue: string | undefined
  /** What the handler's own `config` component must report once the program is up. */
  expectedConfigValue: string | undefined
  /** Whether `peer.<addr>.heartbeat` and `peer.<addr>.disconnect` are expected on the broker. */
  republishes: boolean
}

function heartbeatForwardingProgram(options: HeartbeatForwardingProgram) {
  const { HTTP_SERVER_HOST, HTTP_SERVER_PORT } = defaultServerConfig()

  test(options.suiteName, ({ components, beforeStart }) => {
    const identity = createEphemeralIdentity(`heartbeat-flag-${HTTP_SERVER_PORT}`)

    // `test/components.ts` builds the config from `process.env` and `beforeStart` runs before the
    // program is initialized, so this is the seam for handing the handler the flag. Restored
    // afterwards because jest reuses the worker process for the other programs in this file and
    // for the other spec files.
    const overrides: Record<string, string | undefined> = {
      HEARTBEAT_FORWARDING_ENABLED: options.flagValue,
      HTTP_SERVER_HOST,
      HTTP_SERVER_PORT
    }
    const originalEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))

    beforeStart(async () => {
      applyEnv(overrides)
    })
    afterAll(() => {
      applyEnv(originalEnv)
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

      const welcome = expectPacket<WelcomeMessage>(
        await channel.yield(5000, 'welcome message did not arrive'),
        'welcome'
      )

      return { ws, channel, address: welcome.peerId }
    }

    describe('when an authenticated client sends a heartbeat and then closes', () => {
      let ws: WebSocket | undefined
      let address: string
      let peerSubjects: string[]
      let delivered: ServerPacket | undefined
      let deliveryError: unknown

      beforeAll(async () => {
        // The flag only means something if the handler actually read it. Read it back through the
        // same `config` component `registerWsHandler` reads, so a `test/components.ts` edit that
        // shadows the env override fails here loudly instead of quietly re-testing the default.
        expect(await components.config.getString('HEARTBEAT_FORWARDING_ENABLED')).toBe(options.expectedConfigValue)

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
        address = socket.address

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
          delivered = await socket.channel.yield(5000, 'island_changed did not arrive')
        } catch (error) {
          deliveryError = error
        }

        // The close handler is the other publish site, so the session has to be *over* before the
        // subjects are asserted. Closing in `afterAll` does not do it: jest runs `afterAll` after
        // every `it`, so the assertion would only ever see the window before the socket closed and
        // an unconditional `peer.<addr>.disconnect` would sail through this spec.
        ws.close()
        await settle()
      })

      afterAll(() => {
        // Cleanup for the path where `beforeAll` threw before the close above: `ws` is only assigned
        // once `connectSocket()` resolves, so the optional chain keeps a TypeError here from burying
        // the real error. Closing an already-closed socket is a no-op.
        ws?.close()
      })

      if (options.republishes) {
        it('should republish the heartbeat and then the disconnect on NATS', () => {
          expect(peerSubjects).toEqual([`peer.${address}.heartbeat`, `peer.${address}.disconnect`])
        })
      } else {
        it('should republish neither the heartbeat nor the disconnect on NATS', () => {
          expect(peerSubjects).toEqual([])
        })
      }

      it('should still deliver the island assignment, the message the socket exists to carry', () => {
        expect(deliveryError).toBeUndefined()
        expect(delivered?.message?.$case).toBe('islandChanged')
        expect(delivered?.message?.$case === 'islandChanged' && delivered.message.islandChanged.islandId).toBe(
          'island-heartbeat-flag'
        )
      })
    })
  })
}

/** Set the given keys in `process.env`; an `undefined` value deletes the key. */
function applyEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

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
