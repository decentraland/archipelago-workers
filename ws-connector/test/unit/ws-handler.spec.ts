import { Authenticator } from '@dcl/crypto'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@dcl/metrics'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { ClientPacket } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { registerWsHandler } from '../../src/controllers/handlers/ws-handler'
import { metricDeclarations } from '../../src/metrics'
import { InternalWebSocket, Stage, WsUserData } from '../../src/types'
import { createEphemeralIdentity } from '../helpers/identity'
import { createBanCheckerMockedComponent } from '../mocks/ban-checker-mock'
import { createDenyListMockedComponent } from '../mocks/deny-list-mock'
import { createPeersRegistryMockedComponent } from '../mocks/peers-registry-mock'
import { createSupersedeCooldownMockedComponent } from '../mocks/supersede-cooldown-mock'

/**
 * These drive the handlers `registerWsHandler` actually registers on `server.app.ws`, by
 * capturing the handler object and invoking `open`/`message`/`close` directly against a stubbed
 * socket. That exercises the real production code without needing a µWebSockets server — which
 * is what the previous version of this file avoided by re-implementing the logic in the spec
 * instead, so it passed regardless of what ws-handler.ts did.
 */
type WsHandlers = {
  open: (ws: InternalWebSocket) => void
  message: (ws: InternalWebSocket, message: ArrayBuffer) => Promise<void>
  close: (ws: InternalWebSocket, code: number, message: ArrayBuffer) => void
}

type StubWebSocket = InternalWebSocket & { send: jest.Mock; end: jest.Mock }

const HANDSHAKE_TIMEOUT_MS = 500

describe('ws-handler', () => {
  let handlers: WsHandlers
  let peersRegistry: ReturnType<typeof createPeersRegistryMockedComponent>
  let banChecker: ReturnType<typeof createBanCheckerMockedComponent>
  let denyList: ReturnType<typeof createDenyListMockedComponent>
  let supersedeCooldown: ReturnType<typeof createSupersedeCooldownMockedComponent>
  let nats: { publish: jest.Mock; subscribe: jest.Mock }
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>
  let validateSignature: jest.SpyInstance

  const identity = createEphemeralIdentity('handler-spec')
  const address = identity.address.toLowerCase()

  function makeWs(initial: Partial<WsUserData> = {}): StubWebSocket {
    const data = { stage: Stage.HANDSHAKE_START, ...initial } as WsUserData

    return {
      getUserData: () => data,
      send: jest.fn().mockReturnValue(1),
      end: jest.fn()
    } as unknown as StubWebSocket
  }

  function published(subject: string): unknown[][] {
    return nats.publish.mock.calls.filter(([published]) => published === subject)
  }

  function encode(message: ClientPacket['message']): ArrayBuffer {
    return ClientPacket.encode({ message }).finish() as unknown as ArrayBuffer
  }

  async function build(): Promise<void> {
    peersRegistry = createPeersRegistryMockedComponent()
    banChecker = createBanCheckerMockedComponent()
    denyList = createDenyListMockedComponent()
    supersedeCooldown = createSupersedeCooldownMockedComponent()
    nats = { publish: jest.fn(), subscribe: jest.fn() }
    metrics = createTestMetricsComponent(metricDeclarations)
    jest.spyOn(metrics, 'increment')

    const config = createConfigComponent({ HANDSHAKE_TIMEOUT: String(HANDSHAKE_TIMEOUT_MS) })
    const logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })
    const server = {
      app: {
        ws: jest.fn((_path: string, registered: WsHandlers) => {
          handlers = registered
        })
      }
    }

    await registerWsHandler({
      config,
      logs,
      ethereumProvider: {} as never,
      peersRegistry,
      banChecker,
      denyList,
      supersedeCooldown,
      nats: nats as never,
      server: server as never,
      metrics
    })
  }

  beforeEach(async () => {
    validateSignature = jest.spyOn(Authenticator, 'validateSignature')
    await build()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  describe('when an undecodable packet arrives', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = makeWs()
      handlers.open(ws)
      await handlers.message(ws, new Uint8Array([1, 2, 3, 4, 5, 6]) as unknown as ArrayBuffer)
    })

    it('should close the socket with the protocol-error code and reason', () => {
      expect(ws.end).toHaveBeenCalledWith(1007, Buffer.from('Cannot decode ClientPacket'))
    })

    it('should mark the socket as closed', () => {
      expect(ws.getUserData().isClosed).toBe(true)
    })

    describe('and a second undecodable packet arrives on the same socket', () => {
      beforeEach(async () => {
        ws.end.mockClear()
        await handlers.message(ws, new Uint8Array([9, 9, 9]) as unknown as ArrayBuffer)
      })

      it('should not close it again, since it is already closed', () => {
        expect(ws.end).not.toHaveBeenCalled()
      })
    })
  })

  describe('when closing the socket itself throws', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = makeWs()
      ws.end.mockImplementation(() => {
        throw new Error('socket already gone')
      })
      handlers.open(ws)
    })

    it('should swallow it, since this runs on every rejection path', async () => {
      await expect(handlers.message(ws, new Uint8Array([1, 2, 3]) as unknown as ArrayBuffer)).resolves.toBeUndefined()
    })
  })

  describe('when a packet arrives in an unrecognised stage', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = makeWs({ stage: 99 as never })
      await handlers.message(ws, encode({ $case: 'heartbeat', heartbeat: { position: { x: 0, y: 0, z: 0 } } }))
    })

    it('should ignore it rather than acting on an unknown state', () => {
      expect(ws.send).not.toHaveBeenCalled()
      expect(nats.publish).not.toHaveBeenCalled()
    })
  })

  describe('when nothing is received before the handshake timeout', () => {
    let ws: StubWebSocket

    beforeEach(() => {
      jest.useFakeTimers()
      ws = makeWs()
      handlers.open(ws)
      jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 10)
    })

    it('should close the socket', () => {
      expect(ws.end).toHaveBeenCalled()
    })
  })

  describe('when the socket closes before the handshake timeout fires', () => {
    let ws: StubWebSocket

    beforeEach(() => {
      jest.useFakeTimers()
      ws = makeWs()
      handlers.open(ws)
      handlers.close(ws, 1000, new ArrayBuffer(0))
      jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 10)
    })

    it('should clear the timeout so it cannot fire against a dead socket', () => {
      expect(ws.getUserData().timeout).toBeUndefined()
      expect(ws.end).not.toHaveBeenCalled()
    })
  })

  describe('when a valid challenge request arrives', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = makeWs()
      handlers.open(ws)
      await handlers.message(ws, encode({ $case: 'challengeRequest', challengeRequest: { address } }))
    })

    it('should send a challenge to sign', () => {
      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it('should advance to the challenge-sent stage', () => {
      expect(ws.getUserData().stage).toBe(Stage.HANDSHAKE_CHALLENGE_SENT)
    })

    it('should consult the deny list with the claimed address', () => {
      expect(denyList.isDenylisted).toHaveBeenCalledWith(address)
    })
  })

  describe('when the claimed address is deny-listed', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      denyList.isDenylisted.mockResolvedValue(true)
      ws = makeWs()
      handlers.open(ws)
      await handlers.message(ws, encode({ $case: 'challengeRequest', challengeRequest: { address } }))
    })

    it('should close the socket without issuing a challenge', () => {
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.end).toHaveBeenCalled()
    })
  })

  describe('when a signed challenge authenticates successfully', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: true })
      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-challenge' } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should register the peer under its lower-cased address', () => {
      expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith(address, ws)
    })

    it('should send the welcome message', () => {
      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it('should reach the completed stage without closing the socket', () => {
      expect(ws.getUserData().stage).toBe(Stage.HANDSHAKE_COMPLETED)
      expect(ws.end).not.toHaveBeenCalled()
    })

    it('should announce the new session under the lower-cased address', () => {
      expect(published(`peer.${address}.connect`)).toHaveLength(1)
    })

    it('should carry the session id, so another replica can tell this socket from an older one', () => {
      const [[, payload]] = published(`peer.${address}.connect`)
      const sessionId = ws.getUserData().sessionId

      expect(sessionId).toMatch(/^[0-9a-f]{28}$/)
      expect(Buffer.from(payload as Uint8Array).toString('utf8')).toBe(sessionId)
    })
  })

  describe('when the welcome message cannot be sent', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: true })
      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-challenge' } as Partial<WsUserData>)
      ws.send.mockReturnValue(0)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should close the socket', () => {
      expect(ws.end).toHaveBeenCalled()
    })

    it('should have recorded the address before sending, so the close handler can clean up', () => {
      // The production code sets stage and address *before* the send precisely so a failed
      // welcome is still recoverable. Without it the registry keeps a ghost entry forever.
      expect(ws.getUserData().address).toBe(address)
    })

    it('should not announce a session the client was never told about', () => {
      expect(published(`peer.${address}.connect`)).toHaveLength(0)
    })

    describe('and the close handler then runs', () => {
      beforeEach(() => {
        handlers.close(ws, 1006, new ArrayBuffer(0))
      })

      it('should leave no ghost entry in the peers registry', () => {
        expect(peersRegistry.onPeerDisconnected).toHaveBeenCalledWith(address, ws)
        expect(peersRegistry.getPeerCount()).toBe(0)
      })
    })
  })

  describe('when the protocol is violated', () => {
    let ws: StubWebSocket

    describe('and the first packet is not a challenge request', () => {
      beforeEach(async () => {
        ws = makeWs()
        handlers.open(ws)
        await handlers.message(ws, encode({ $case: 'heartbeat', heartbeat: { position: { x: 0, y: 0, z: 0 } } }))
      })

      it('should close the socket', () => {
        expect(ws.end).toHaveBeenCalled()
      })
    })

    describe('and the claimed address is not a valid eth address', () => {
      beforeEach(async () => {
        ws = makeWs()
        handlers.open(ws)
        await handlers.message(ws, encode({ $case: 'challengeRequest', challengeRequest: { address: 'nonsense' } }))
      })

      it('should close the socket without consulting the deny list', () => {
        expect(ws.end).toHaveBeenCalled()
        expect(denyList.isDenylisted).not.toHaveBeenCalled()
      })
    })

    describe('and the challenge cannot be sent', () => {
      beforeEach(async () => {
        ws = makeWs()
        ws.send.mockReturnValue(0)
        handlers.open(ws)
        await handlers.message(ws, encode({ $case: 'challengeRequest', challengeRequest: { address } }))
      })

      it('should close the socket rather than wait for a reply that cannot come', () => {
        expect(ws.end).toHaveBeenCalled()
      })
    })

    describe('and the second packet is not a signed challenge', () => {
      beforeEach(async () => {
        ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-x' } as Partial<WsUserData>)
        await handlers.message(ws, encode({ $case: 'heartbeat', heartbeat: { position: { x: 0, y: 0, z: 0 } } }))
      })

      it('should close the socket', () => {
        expect(ws.end).toHaveBeenCalled()
      })
    })

    describe('and the auth chain is malformed', () => {
      beforeEach(async () => {
        ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-x' } as Partial<WsUserData>)
        await handlers.message(
          ws,
          encode({ $case: 'signedChallenge', signedChallenge: { authChainJson: JSON.stringify([{ bogus: true }]) } })
        )
      })

      it('should close the socket without attempting to validate the signature', () => {
        expect(ws.end).toHaveBeenCalled()
        expect(validateSignature).not.toHaveBeenCalled()
      })
    })

    describe('and the auth chain json is not parseable', () => {
      beforeEach(async () => {
        ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-x' } as Partial<WsUserData>)
        await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson: '{{{' } }))
      })

      it('should contain the parse failure and close the socket', () => {
        expect(ws.end).toHaveBeenCalled()
      })
    })
  })

  describe('when the signature does not validate', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: false, message: 'bad signature' })
      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-challenge' } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should close the socket without registering the peer', () => {
      expect(ws.end).toHaveBeenCalled()
      expect(peersRegistry.onPeerConnected).not.toHaveBeenCalled()
    })
  })

  describe('when the same identity reconnects while an older socket is live', () => {
    let previousWs: StubWebSocket
    let ws: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: true })
      previousWs = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
      peersRegistry.onPeerConnected(address, previousWs)

      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-challenge' } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should kick and close the previous socket', () => {
      expect(previousWs.send).toHaveBeenCalled()
      expect(previousWs.end).toHaveBeenCalled()
    })

    it('should register the new socket in its place', () => {
      expect(peersRegistry.getPeerWs(address)).toBe(ws)
    })

    it('should start the cooldown, so the kicked session cannot immediately retake the slot', () => {
      expect(supersedeCooldown.onSuperseded).toHaveBeenCalledWith(address)
    })

    it('should announce the supersede, so every other replica arms the same window', () => {
      expect(published(`peer.${address}.superseded`)).toHaveLength(1)
    })
  })

  describe('when the kick to the previous socket cannot be sent', () => {
    let previousWs: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: true })
      previousWs = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
      previousWs.send.mockReturnValue(0)
      peersRegistry.onPeerConnected(address, previousWs)

      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      const ws = makeWs({
        stage: Stage.HANDSHAKE_CHALLENGE_SENT,
        challengeToSign: 'dcl-challenge'
      } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should still close it, so the old session cannot linger', () => {
      expect(previousWs.end).toHaveBeenCalled()
    })
  })

  describe('when the registry still holds a socket that already closed', () => {
    let previousWs: StubWebSocket
    let ws: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: true })
      previousWs = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address, isClosed: true } as Partial<WsUserData>)
      peersRegistry.onPeerConnected(address, previousWs)

      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-challenge' } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should not start the cooldown, since no live session was superseded', () => {
      expect(supersedeCooldown.onSuperseded).not.toHaveBeenCalled()
    })

    it('should register the new socket, so an ordinary reconnect is never penalised', () => {
      expect(peersRegistry.getPeerWs(address)).toBe(ws)
    })
  })

  describe('when a handshake arrives while the address is cooling down', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      validateSignature.mockResolvedValue({ ok: true })
      supersedeCooldown.isCoolingDown.mockReturnValue(true)

      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-challenge' } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
    })

    it('should close the socket without welcoming it', () => {
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.end).toHaveBeenCalled()
    })

    it('should not register it, so the live session keeps the slot', () => {
      expect(peersRegistry.onPeerConnected).not.toHaveBeenCalled()
    })

    it('should not announce a session that was refused', () => {
      expect(published(`peer.${address}.connect`)).toHaveLength(0)
    })

    it('should count the refusal', () => {
      expect(metrics.increment).toHaveBeenCalledWith('dcl_ws_connector_supersede_cooldown_refusals_total')
    })

    describe('and the refused socket then closes', () => {
      beforeEach(() => {
        handlers.close(ws, 1000, new ArrayBuffer(0))
      })

      it('should not announce a disconnect for an address it never registered', () => {
        expect(peersRegistry.onPeerDisconnected).not.toHaveBeenCalled()
        expect(nats.publish).not.toHaveBeenCalledWith(`peer.${address}.disconnect`)
      })
    })

    describe('and a live socket already holds the address', () => {
      let previousWs: StubWebSocket

      beforeEach(async () => {
        previousWs = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
        peersRegistry.onPeerConnected(address, previousWs)

        const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
        const late = makeWs({
          stage: Stage.HANDSHAKE_CHALLENGE_SENT,
          challengeToSign: 'dcl-challenge'
        } as Partial<WsUserData>)

        await handlers.message(late, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))
      })

      it('should leave the incumbent alone rather than kicking it as well', () => {
        expect(previousWs.send).not.toHaveBeenCalled()
        expect(previousWs.end).not.toHaveBeenCalled()
        expect(peersRegistry.getPeerWs(address)).toBe(previousWs)
      })
    })
  })

  describe('when a heartbeat arrives after the handshake completed', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'heartbeat', heartbeat: { position: { x: 1, y: 2, z: 3 } } }))
    })

    it('should republish it on the peer heartbeat subject', () => {
      expect(nats.publish).toHaveBeenCalledWith(`peer.${address}.heartbeat`, expect.any(Uint8Array))
    })
  })

  describe('when an authenticated socket closes', () => {
    let ws: StubWebSocket

    beforeEach(() => {
      ws = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
      peersRegistry.onPeerConnected(address, ws)

      handlers.close(ws, 1000, new ArrayBuffer(0))
    })

    it('should remove the peer from the registry', () => {
      expect(peersRegistry.onPeerDisconnected).toHaveBeenCalledWith(address, ws)
      expect(peersRegistry.getPeerCount()).toBe(0)
    })

    it('should announce the disconnect so the rest of the platform notices', () => {
      expect(nats.publish).toHaveBeenCalledWith(`peer.${address}.disconnect`)
    })
  })
})
