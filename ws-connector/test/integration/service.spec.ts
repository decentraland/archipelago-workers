import { IslandChangedMessage, ServerPacket } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { createLocalNatsComponent } from '@well-known-components/nats-component'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createTestMetricsComponent } from '@dcl/metrics'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { main } from '../../src/service'
import { metricDeclarations } from '../../src/metrics'
import { InternalWebSocket } from '../../src/types'
import { createBanCheckerMockedComponent } from '../mocks/ban-checker-mock'
import { createDenyListMockedComponent } from '../mocks/deny-list-mock'
import { createLoggerMockedComponent } from '../mocks/logger-mock'
import { createPeersRegistryMockedComponent } from '../mocks/peers-registry-mock'

/**
 * Drives the real `main()` against a local NATS broker, so the subscription, the subject
 * parsing, the decode and the forwarding are the production ones. The previous version of this
 * file re-implemented all of that inside the spec, which meant it passed no matter what
 * src/service.ts did.
 */
const PEER = '0xaaaabbbbccccddddeeeeffff0000111122223333'
const DESKTOP = '0xd000000000000000000000000000000000000001'
const LAPTOP = '0xd000000000000000000000000000000000000002'

describe('ws-connector island change forwarding', () => {
  let nats: INatsComponent
  let peersRegistry: ReturnType<typeof createPeersRegistryMockedComponent>
  let logs: ReturnType<typeof createLoggerMockedComponent>
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>
  let sent: Uint8Array[]

  function connectPeer(id: string, session: string): InternalWebSocket {
    const userData = {}
    const ws = {
      send: jest.fn((data: Uint8Array) => {
        sent.push(data)
        return 1
      }),
      end: jest.fn(),
      getUserData: () => userData
    } as unknown as InternalWebSocket

    peersRegistry.onPeerConnected(id, session, ws)

    return ws
  }

  function publishIslandChanged(peerId: string, message: Partial<IslandChangedMessage>): void {
    nats.publish(
      `engine.peer.${peerId}.island_changed`,
      IslandChangedMessage.encode({ islandId: '', connStr: '', peers: {}, ...message }).finish()
    )
  }

  function publishIslandChangedTo(peerId: string, session: string, message: Partial<IslandChangedMessage>): void {
    nats.publish(
      `engine.peer.${peerId}.island_changed.${session}`,
      IslandChangedMessage.encode({ islandId: '', connStr: '', peers: {}, ...message }).finish()
    )
  }

  function publishRaw(peerId: string, data: Uint8Array): void {
    nats.publish(`engine.peer.${peerId}.island_changed`, data)
  }

  /** The subscription callback runs off the broker's own loop, so let it drain. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50))
  }

  function lastForwarded(): ServerPacket {
    return ServerPacket.decode(sent[sent.length - 1])
  }

  async function start(dedupMs?: string): Promise<void> {
    // A fresh broker each call, so a nested describe rebuilding with a different dedup window gets
    // a clean subscription set instead of layering a second one on top of the first.
    nats = await createLocalNatsComponent()
    const config = createConfigComponent({
      LOG_LEVEL: 'ERROR',
      HANDSHAKE_TIMEOUT: '1000',
      ...(dedupMs !== undefined ? { ISLAND_CHANGED_DEDUP_MS: dedupMs } : {})
    })
    const server = { app: { get: jest.fn(), any: jest.fn(), ws: jest.fn() } }

    await main({
      components: {
        config,
        logs,
        server: server as never,
        fetch: { fetch: jest.fn() } as never,
        metrics,
        nats,
        peersRegistry,
        banChecker: createBanCheckerMockedComponent(),
        denyList: createDenyListMockedComponent(),
        banSweep: {},
        ethereumProvider: {} as never
      },
      startComponents: async () => {}
    } as never)
  }

  beforeEach(async () => {
    sent = []
    peersRegistry = createPeersRegistryMockedComponent()
    logs = createLoggerMockedComponent()
    metrics = createTestMetricsComponent(metricDeclarations)
    jest.spyOn(metrics, 'increment')

    await start()
  })

  describe('when an island change arrives for a connected peer', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChanged(PEER, { islandId: 'island-C7', connStr: 'livekit:wss://host?access_token=jwt' })
      await settle()
    })

    it('should forward exactly one message to that peer', () => {
      expect(sent).toHaveLength(1)
    })

    it('should forward it as an islandChanged server packet', () => {
      expect(lastForwarded().message?.$case).toBe('islandChanged')
    })

    it('should preserve the island id', () => {
      const packet = lastForwarded()
      expect(packet.message?.$case === 'islandChanged' && packet.message.islandChanged.islandId).toBe('island-C7')
    })

    it('should preserve the connection string, which is the only field the explorer reads', () => {
      const packet = lastForwarded()
      expect(packet.message?.$case === 'islandChanged' && packet.message.islandChanged.connStr).toBe(
        'livekit:wss://host?access_token=jwt'
      )
    })
  })

  describe('and the message subject carries a checksummed address', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChanged(PEER.toUpperCase(), { islandId: 'island-C8' })
      await settle()
    })

    it('should normalize the subject address before looking up the peer socket', () => {
      const packet = lastForwarded()
      expect(packet.message?.$case === 'islandChanged' && packet.message.islandChanged.islandId).toBe('island-C8')
    })
  })

  describe('and the message carries a previous island', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChanged(PEER, { islandId: 'island-C8', fromIslandId: 'island-C7' })
      await settle()
    })

    it('should preserve fromIslandId so the explorer knows which room to leave', () => {
      const packet = lastForwarded()
      expect(packet.message?.$case === 'islandChanged' && packet.message.islandChanged.fromIslandId).toBe('island-C7')
    })
  })

  describe('when the send to the peer fails', () => {
    beforeEach(async () => {
      const ws = {
        send: jest.fn().mockReturnValue(0),
        end: jest.fn(),
        getUserData: jest.fn().mockReturnValue({})
      } as unknown as InternalWebSocket
      peersRegistry.onPeerConnected(PEER, DESKTOP, ws)

      publishIslandChanged(PEER, { islandId: 'island-C7' })
      await settle()
    })

    it('should warn rather than fail silently, since the peer never got its room', () => {
      expect(logs.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to send island change'))
    })
  })

  describe('when the peer is not connected to this replica', () => {
    beforeEach(async () => {
      publishIslandChanged('0xnotconnected', { islandId: 'island-C7' })
      await settle()
    })

    it('should drop it silently, since another replica holds that socket', () => {
      expect(sent).toHaveLength(0)
      expect(logs.logger.error).not.toHaveBeenCalledWith(expect.stringContaining('cannot process'))
    })
  })

  describe('when the payload cannot be decoded', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishRaw(PEER, new Uint8Array([0xff, 0xff, 0xff, 0xff]))
      await settle()
    })

    it('should contain the failure instead of letting it escape the callback', () => {
      // A throw escaping here stops delivery on every subject on the connection, not just this
      // one — which is what the guarded() wrapper exists to prevent.
      expect(logs.logger.error).toHaveBeenCalledWith(expect.stringContaining('cannot process island_changed message'))
    })

    it('should forward nothing', () => {
      expect(sent).toHaveLength(0)
    })
  })

  describe('and a well-formed message arrives after a malformed one', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishRaw(PEER, new Uint8Array([0xff, 0xff, 0xff, 0xff]))
      await settle()
      publishIslandChanged(PEER, { islandId: 'island-C9' })
      await settle()
    })

    it('should still be delivered, proving the subscription survived', () => {
      const packet = lastForwarded()
      expect(packet.message?.$case === 'islandChanged' && packet.message.islandChanged.islandId).toBe('island-C9')
    })
  })

  describe('when a session-addressed island change arrives', () => {
    let desktop: InternalWebSocket
    let laptop: InternalWebSocket

    beforeEach(async () => {
      desktop = connectPeer(PEER, DESKTOP)
      laptop = connectPeer(PEER, LAPTOP)
      publishIslandChangedTo(PEER, LAPTOP, {
        islandId: 'island-C9',
        connStr: 'livekit:wss://host?access_token=jwt-laptop'
      })
      await settle()
    })

    it('should forward it to the socket holding that session only', () => {
      expect(laptop.send as jest.Mock).toHaveBeenCalledTimes(1)
      expect(desktop.send as jest.Mock).not.toHaveBeenCalled()
    })

    it('should preserve the connection string', () => {
      const packet = lastForwarded()
      expect(packet.message?.$case === 'islandChanged' && packet.message.islandChanged.connStr).toBe(
        'livekit:wss://host?access_token=jwt-laptop'
      )
    })
  })

  describe('when a session-addressed island change names a session this replica does not hold', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChangedTo(PEER, LAPTOP, { islandId: 'island-C9', connStr: 'x' })
      await settle()
    })

    it('should forward nothing', () => {
      expect(sent).toHaveLength(0)
    })

    it('should count the miss', () => {
      expect(metrics.increment).toHaveBeenCalledWith('dcl_ws_connector_island_changed_no_session_socket_total')
    })
  })

  describe('when a session-addressed island change names a wallet this replica does not hold at all', () => {
    beforeEach(async () => {
      publishIslandChangedTo(PEER, LAPTOP, { islandId: 'island-C9', connStr: 'x' })
      await settle()
    })

    it('should forward nothing', () => {
      expect(sent).toHaveLength(0)
    })

    it('should not count a miss, since ordinary fan-out is not a stale session', () => {
      expect(metrics.increment).not.toHaveBeenCalledWith('dcl_ws_connector_island_changed_no_session_socket_total')
    })
  })

  describe('when a legacy island change arrives for a wallet with two sessions', () => {
    let desktop: InternalWebSocket
    let laptop: InternalWebSocket

    beforeEach(async () => {
      desktop = connectPeer(PEER, DESKTOP)
      laptop = connectPeer(PEER, LAPTOP)
      publishIslandChanged(PEER, { islandId: 'island-C7', connStr: 'x' })
      await settle()
    })

    it('should forward it to the newest socket only, matching the last-wins behaviour it replaces', () => {
      expect(laptop.send as jest.Mock).toHaveBeenCalledTimes(1)
      expect(desktop.send as jest.Mock).not.toHaveBeenCalled()
    })
  })

  describe('when the same island is forwarded twice to one socket within the dedup window', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C7', connStr: 'a' })
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C7', connStr: 'b' })
      await settle()
    })

    it('should forward only the first', () => {
      expect(sent).toHaveLength(1)
    })

    it('should count the duplicate', () => {
      expect(metrics.increment).toHaveBeenCalledWith('dcl_ws_connector_island_changed_deduplicated_total')
    })
  })

  describe('when a different island follows within the window', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C7', connStr: 'a' })
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C8', connStr: 'b' })
      await settle()
    })

    it('should forward both', () => {
      expect(sent).toHaveLength(2)
    })

    it('should not count a duplicate', () => {
      expect(metrics.increment).not.toHaveBeenCalledWith('dcl_ws_connector_island_changed_deduplicated_total')
    })
  })

  describe('when the same island is forwarded twice across the two subjects', () => {
    beforeEach(async () => {
      connectPeer(PEER, DESKTOP)
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C7', connStr: 'a' })
      publishIslandChanged(PEER, { islandId: 'island-C7', connStr: 'b' })
      await settle()
    })

    it('should forward only the first, since the legacy path is deduplicated too', () => {
      expect(sent).toHaveLength(1)
    })
  })

  describe('when dedup is disabled', () => {
    beforeEach(async () => {
      await start('0')
      connectPeer(PEER, DESKTOP)
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C7', connStr: 'a' })
      publishIslandChangedTo(PEER, DESKTOP, { islandId: 'island-C7', connStr: 'b' })
      await settle()
    })

    it('should forward both messages', () => {
      expect(sent).toHaveLength(2)
    })
  })
})
