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

// The object handed to `server.app.ws` carries the route's uWS options as well as its handlers.
type RouteOptions = { idleTimeout?: number; sendPingsAutomatically?: boolean }

const HANDSHAKE_TIMEOUT_MS = 500

describe('ws-handler', () => {
  let handlers: WsHandlers
  let routeOptions: RouteOptions
  let peersRegistry: ReturnType<typeof createPeersRegistryMockedComponent>
  let banChecker: ReturnType<typeof createBanCheckerMockedComponent>
  let denyList: ReturnType<typeof createDenyListMockedComponent>
  let nats: { publish: jest.Mock; subscribe: jest.Mock }
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>
  let incrementMetric: jest.SpyInstance
  let validateSignature: jest.SpyInstance
  let loggerWarn: jest.Mock
  let loggerError: jest.Mock

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

  function encode(message: ClientPacket['message']): ArrayBuffer {
    return ClientPacket.encode({ message }).finish() as unknown as ArrayBuffer
  }

  /** A completed session that sends one heartbeat and then goes away — both publish sites, in order. */
  async function heartbeatThenClose(): Promise<StubWebSocket> {
    const ws = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
    peersRegistry.onPeerConnected(address, ws)

    await handlers.message(ws, encode({ $case: 'heartbeat', heartbeat: { position: { x: 1, y: 2, z: 3 } } }))
    handlers.close(ws, 1000, new ArrayBuffer(0))

    return ws
  }

  /**
   * One real handshake, driven through the second stage exactly as a client does — so the peer is
   * registered and the welcome sent by the production code, not by the spec.
   */
  async function completeHandshake(): Promise<StubWebSocket> {
    validateSignature.mockResolvedValue({ ok: true })
    const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
    const ws = makeWs({
      stage: Stage.HANDSHAKE_CHALLENGE_SENT,
      challengeToSign: 'dcl-challenge'
    } as Partial<WsUserData>)

    await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))

    return ws
  }

  /**
   * The same handshake, but the socket dies while it is suspended on the ban check — the widest
   * of the handshake's awaits, because it is an out-of-process call. uWS delivers `close` while
   * the handshake is parked, and the handshake then resumes holding a socket that is gone.
   */
  async function handshakeClosingInsideTheBanCheck(): Promise<StubWebSocket> {
    validateSignature.mockResolvedValue({ ok: true })
    const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
    const ws = makeWs({
      stage: Stage.HANDSHAKE_CHALLENGE_SENT,
      challengeToSign: 'dcl-challenge'
    } as Partial<WsUserData>)

    banChecker.isBanned.mockImplementation(async () => {
      handlers.close(ws, 1006, new ArrayBuffer(0))
      return false
    })

    await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))

    return ws
  }

  async function build(configOverrides: Record<string, string> = {}): Promise<void> {
    peersRegistry = createPeersRegistryMockedComponent()
    banChecker = createBanCheckerMockedComponent()
    denyList = createDenyListMockedComponent()
    nats = { publish: jest.fn(), subscribe: jest.fn() }
    metrics = createTestMetricsComponent(metricDeclarations)
    incrementMetric = jest.spyOn(metrics, 'increment')
    loggerWarn = jest.fn()
    loggerError = jest.fn()

    const config = createConfigComponent({ HANDSHAKE_TIMEOUT: String(HANDSHAKE_TIMEOUT_MS), ...configOverrides })
    // The real logger, with `warn` and `error` made observable — the switch warns on a value it
    // does not recognise, and the handshake announcement logs a broker that refuses it, and both
    // are asserted on. Everything else in this file relies on the logger's actual behaviour.
    const realLogs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })
    const logs = {
      getLogger: (name: string) => ({ ...realLogs.getLogger(name), warn: loggerWarn, error: loggerError })
    }
    const server = {
      app: {
        ws: jest.fn((_path: string, registered: WsHandlers & RouteOptions) => {
          handlers = registered
          routeOptions = registered
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

  // uWS accepts only 0 or values >= 8 for `idleTimeout` and aborts route registration otherwise,
  // with 'idleTimeout must be either 0 or greater than 8!' — a message naming neither the config
  // key nor this file. These pin that the handler screens the value itself.
  describe('when the configured idle timeout is one uWS accepts', () => {
    it.each([
      [0, "uWS's never-time-out"],
      [8, 'the smallest positive value uWS takes'],
      [90, 'the historical production default']
    ])('should hand %d, %s, to the route unchanged', async (seconds) => {
      await build({ WS_IDLE_TIMEOUT_SECONDS: String(seconds) })

      expect(routeOptions.idleTimeout).toBe(seconds)
    })
  })

  describe('when the configured idle timeout is one uWS rejects', () => {
    it('should fail at startup naming the key, rather than crash-loop inside uWS', async () => {
      await expect(build({ WS_IDLE_TIMEOUT_SECONDS: '5' })).rejects.toThrow(/WS_IDLE_TIMEOUT_SECONDS.+0.+8/)
    })
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

  // Iteration 2 retires the client heartbeat: `peer.*.heartbeat` and `peer.*.disconnect` lose
  // their only consumer (archipelago-stats). `HEARTBEAT_FORWARDING_ENABLED` switches the intake
  // off ahead of deleting the code, so it must default to today's behaviour — a deploy that sets
  // nothing still publishes both subjects.
  describe('when HEARTBEAT_FORWARDING_ENABLED is left unset', () => {
    beforeEach(async () => {
      await heartbeatThenClose()
    })

    it('should publish the heartbeat and the disconnect, exactly as before the flag existed', () => {
      expect(nats.publish).toHaveBeenNthCalledWith(1, `peer.${address}.heartbeat`, expect.any(Uint8Array))
      expect(nats.publish).toHaveBeenNthCalledWith(2, `peer.${address}.disconnect`)
      expect(nats.publish).toHaveBeenCalledTimes(2)
    })

    it('should say nothing about a key nobody set', () => {
      expect(loggerWarn).not.toHaveBeenCalled()
    })
  })

  // The value is read leniently, and never throws: this is a rollback switch an operator types by
  // hand under time pressure, and `registerWsHandler` runs inside the Lifecycle entrypoint — a
  // throw here means `/ws` is never registered and every client loses its gateway over a typo.
  describe('when HEARTBEAT_FORWARDING_ENABLED holds a value that reads as on', () => {
    it.each([['true'], ['TRUE'], [' true '], ['1'], ['yes'], ['on'], [''], ['  ']])(
      'should publish both subjects for %p, as today',
      async (value) => {
        await build({ HEARTBEAT_FORWARDING_ENABLED: value })
        await heartbeatThenClose()

        expect(nats.publish).toHaveBeenNthCalledWith(1, `peer.${address}.heartbeat`, expect.any(Uint8Array))
        expect(nats.publish).toHaveBeenNthCalledWith(2, `peer.${address}.disconnect`)
        expect(nats.publish).toHaveBeenCalledTimes(2)
        expect(loggerWarn).not.toHaveBeenCalled()
      }
    )
  })

  describe('when HEARTBEAT_FORWARDING_ENABLED holds a value that reads as off', () => {
    it.each([['false'], ['FALSE'], [' false '], ['0'], ['no'], ['off']])(
      'should publish neither subject for %p',
      async (value) => {
        await build({ HEARTBEAT_FORWARDING_ENABLED: value })
        await heartbeatThenClose()

        expect(nats.publish).not.toHaveBeenCalled()
        expect(loggerWarn).not.toHaveBeenCalled()
      }
    )
  })

  describe('when HEARTBEAT_FORWARDING_ENABLED holds a value it does not recognise', () => {
    beforeEach(async () => {
      await build({ HEARTBEAT_FORWARDING_ENABLED: 'maybe' })
    })

    it('should keep forwarding, which is the default and today’s behaviour, rather than fail the deploy', async () => {
      await heartbeatThenClose()

      expect(nats.publish).toHaveBeenNthCalledWith(1, `peer.${address}.heartbeat`, expect.any(Uint8Array))
      expect(nats.publish).toHaveBeenNthCalledWith(2, `peer.${address}.disconnect`)
    })

    it('should warn, naming the key and the value, so the flip that did not happen is visible', () => {
      expect(loggerWarn).toHaveBeenCalledTimes(1)
      const [message] = loggerWarn.mock.calls[0]
      expect(message).toContain('HEARTBEAT_FORWARDING_ENABLED')
      expect(message).toContain('maybe')
    })

    it.each([['disabled'], ['1)'], ['ture'], ['null']])('should not throw on %p', async (value) => {
      await expect(build({ HEARTBEAT_FORWARDING_ENABLED: value })).resolves.toBeUndefined()
    })
  })

  describe('when HEARTBEAT_FORWARDING_ENABLED is false', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      await build({ HEARTBEAT_FORWARDING_ENABLED: 'false' })
      ws = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
      peersRegistry.onPeerConnected(address, ws)

      await handlers.message(ws, encode({ $case: 'heartbeat', heartbeat: { position: { x: 1, y: 2, z: 3 } } }))
    })

    it('should publish nothing for the heartbeat', () => {
      expect(nats.publish).not.toHaveBeenCalled()
    })

    // Clients on old builds keep sending heartbeats after the flip; the packet stays a valid
    // message on a live session, so the socket must survive it rather than be torn down.
    it('should still accept the packet and keep the session open', () => {
      expect(ws.end).not.toHaveBeenCalled()
      expect(ws.getUserData().isClosed).toBeFalsy()
      expect(ws.getUserData().stage).toBe(Stage.HANDSHAKE_COMPLETED)
    })

    describe('and the socket then closes', () => {
      beforeEach(() => {
        handlers.close(ws, 1000, new ArrayBuffer(0))
      })

      it('should publish nothing for the disconnect either', () => {
        expect(nats.publish).not.toHaveBeenCalled()
      })

      it('should still evict the peer from the registry, which is what forwarding relies on', () => {
        expect(peersRegistry.onPeerDisconnected).toHaveBeenCalledWith(address, ws)
        expect(peersRegistry.getPeerCount()).toBe(0)
      })
    })
  })

  // Iteration 2's replacement for what the client heartbeat used to provide. comms-gatekeeper
  // publishes `engine.peer.<addr>.island_changed` only when Pulse reports a cluster change, so a
  // socket that reconnects mid-cluster — a network blip, or the explorer’s own forced re-handshake
  // after repeated LiveKit failures — would otherwise sit with no island until the crowd moved.
  // archipelago-core covered that with the next heartbeat; `peer.<addr>.connect` is the explicit
  // signal that replaces it.
  describe('when a handshake completes', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = await completeHandshake()
    })

    it('should announce the peer on its connect subject, with no payload', () => {
      expect(nats.publish).toHaveBeenCalledWith(`peer.${address}.connect`)
    })

    it('should announce it exactly once, so gatekeeper re-emits one assignment per handshake', () => {
      expect(nats.publish).toHaveBeenCalledTimes(1)
    })

    it('should announce it only once the peer is registered, so the re-emit cannot outrun the socket', () => {
      expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith(address, ws)
      expect(peersRegistry.onPeerConnected.mock.invocationCallOrder[0]).toBeLessThan(
        nats.publish.mock.invocationCallOrder[0]
      )
    })

    it('should keep the session, unchanged by the announcement', () => {
      expect(ws.getUserData().stage).toBe(Stage.HANDSHAKE_COMPLETED)
      expect(ws.end).not.toHaveBeenCalled()
    })
  })

  // The announcement is not part of the heartbeat intake: it is what keeps a reconnect working
  // once that intake is off, so it must survive every value of the flag that retires it. The
  // rollout order depends on it — step 7 turns client heartbeats off across the fleet.
  describe.each([['false'], ['0'], ['no'], ['off'], ['true'], ['1'], [''], ['maybe']])(
    'when a handshake completes with HEARTBEAT_FORWARDING_ENABLED set to %p',
    (value) => {
      beforeEach(async () => {
        await build({ HEARTBEAT_FORWARDING_ENABLED: value })
        await completeHandshake()
      })

      it('should still announce the handshake', () => {
        expect(nats.publish).toHaveBeenCalledWith(`peer.${address}.connect`)
        expect(nats.publish).toHaveBeenCalledTimes(1)
      })
    }
  )

  // Every one of these rejects the connection before the peer is ever registered. Announcing on
  // any of them asks gatekeeper to mint and publish an assignment for a wallet that has no socket.
  describe('when a handshake does not complete', () => {
    it('should announce nothing when the signature does not validate', async () => {
      validateSignature.mockResolvedValue({ ok: false, message: 'bad signature' })
      const authChainJson = JSON.stringify(await identity.sign('dcl-challenge'))
      const ws = makeWs({
        stage: Stage.HANDSHAKE_CHALLENGE_SENT,
        challengeToSign: 'dcl-challenge'
      } as Partial<WsUserData>)

      await handlers.message(ws, encode({ $case: 'signedChallenge', signedChallenge: { authChainJson } }))

      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should announce nothing when the authenticated wallet is deny-listed', async () => {
      denyList.isDenylisted.mockResolvedValue(true)

      await completeHandshake()

      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should announce nothing when the authenticated wallet is platform-banned', async () => {
      banChecker.isBanned.mockResolvedValue(true)

      await completeHandshake()

      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should announce nothing when the auth chain is malformed', async () => {
      const ws = makeWs({ stage: Stage.HANDSHAKE_CHALLENGE_SENT, challengeToSign: 'dcl-x' } as Partial<WsUserData>)

      await handlers.message(
        ws,
        encode({ $case: 'signedChallenge', signedChallenge: { authChainJson: JSON.stringify([{ bogus: true }]) } })
      )

      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should announce nothing for a socket that only got as far as the challenge', async () => {
      const ws = makeWs()
      handlers.open(ws)

      await handlers.message(ws, encode({ $case: 'challengeRequest', challengeRequest: { address } }))

      expect(nats.publish).not.toHaveBeenCalled()
    })
  })

  // The close handler evicts a peer only when it finds an address on the user data, so the address
  // has to be there before the peer enters the registry. Assigned after it, a close landing in
  // between walks past a registered peer and strands the entry for the life of the process.
  describe('when a handshake registers the peer', () => {
    let addressWhenRegistered: string | undefined

    beforeEach(async () => {
      addressWhenRegistered = undefined
      const register = peersRegistry.onPeerConnected.getMockImplementation()!
      peersRegistry.onPeerConnected.mockImplementation((id: string, socket: InternalWebSocket) => {
        addressWhenRegistered = socket.getUserData().address
        register(id, socket)
      })

      await completeHandshake()
    })

    it('should already carry the address on the user data, so any later close can evict it', () => {
      expect(addressWhenRegistered).toBe(address)
    })
  })

  // Three awaits sit between the signed challenge and the announcement — signature validation, the
  // deny list, and the out-of-process ban check — and a TCP connection can drop inside any of
  // them. uWS runs `close` first, which only marks the user data; the suspended handshake then
  // resumes against a socket that no longer exists. Registering it leaves an entry the close
  // already walked past, and announcing it asks comms-gatekeeper to mint a LiveKit token and
  // re-emit an island for a session that is gone — which `src/service.ts` then tries to deliver
  // on a closed socket.
  describe('when the socket closes while the handshake is still awaiting', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      ws = await handshakeClosingInsideTheBanCheck()
    })

    it('should not register the dead socket', () => {
      expect(peersRegistry.onPeerConnected).not.toHaveBeenCalled()
      expect(peersRegistry.getPeerCount()).toBe(0)
    })

    it('should not announce it, so gatekeeper is not asked to assign an island to a gone session', () => {
      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should leave the island_changed forwarder nothing to deliver to', () => {
      // `src/service.ts` filters on `getPeerWs`: an entry here is what makes it call `send` on a
      // closed uWS socket and log the throw as a processing error.
      expect(peersRegistry.getPeerWs(address)).toBeUndefined()
    })

    it('should not try to send a welcome, and should count no publish failure', () => {
      expect(ws.send).not.toHaveBeenCalled()
      expect(loggerError).not.toHaveBeenCalled()
      expect(incrementMetric).not.toHaveBeenCalledWith('ws_connector_peer_connect_publish_failures_total')
    })
  })

  describe('when the socket closes while the handshake is still awaiting and the wallet has a live session', () => {
    let previousWs: StubWebSocket

    beforeEach(async () => {
      previousWs = makeWs({ stage: Stage.HANDSHAKE_COMPLETED, address } as Partial<WsUserData>)
      peersRegistry.onPeerConnected(address, previousWs)
      peersRegistry.onPeerConnected.mockClear()

      await handshakeClosingInsideTheBanCheck()
    })

    it('should not kick the live session on behalf of a socket that is gone', () => {
      expect(previousWs.send).not.toHaveBeenCalled()
      expect(previousWs.end).not.toHaveBeenCalled()
      expect(previousWs.getUserData().isClosed).toBeFalsy()
    })

    it('should leave the live session registered, and announce nothing', () => {
      expect(peersRegistry.getPeerWs(address)).toBe(previousWs)
      expect(peersRegistry.onPeerConnected).not.toHaveBeenCalled()
      expect(nats.publish).not.toHaveBeenCalled()
    })
  })

  // `nats.publish` throws synchronously when the component was never started or the connection is
  // gone. By then the peer is registered and the welcome is about to go out: a client with no
  // island is degraded and re-handshakes, a client with no socket is broken.
  describe('when NATS cannot take the handshake announcement', () => {
    let ws: StubWebSocket

    beforeEach(async () => {
      nats.publish.mockImplementation(() => {
        throw new Error('NATS component was not started yet')
      })
      ws = await completeHandshake()
    })

    it('should still finish the handshake and keep the socket', () => {
      expect(ws.getUserData().stage).toBe(Stage.HANDSHAKE_COMPLETED)
      expect(ws.getUserData().isClosed).toBeFalsy()
      expect(ws.end).not.toHaveBeenCalled()
      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it('should log the failure, naming the subject that was lost', () => {
      expect(loggerError).toHaveBeenCalledTimes(1)
      expect(String(loggerError.mock.calls[0][0])).toContain(`peer.${address}.connect`)
    })

    it('should count it, so a broker that is refusing the announcement is visible on /metrics', () => {
      expect(incrementMetric).toHaveBeenCalledWith('ws_connector_peer_connect_publish_failures_total')
    })
  })
})
