import expect from 'assert'
import { PeerPositionChange, IslandUpdates, ChangeToIslandUpdate, Island, Engine } from '../../src/types'
import { sequentialIdGenerator } from '../../src/logic/idGenerator'
import { expectIslandsWith, expectIslandWith, setMultiplePeersAround } from '../helpers/archipelago'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createArchipelagoEngine } from '../../src/adapters/engine'

type PositionWithId = [string, number, number, number]

describe('engine', () => {
  let engine: Engine

  beforeEach(async () => {
    const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
    const logs = await createLogComponent({ config })
    const metrics = createTestMetricsComponent(metricDeclarations)

    const publisher = {
      onChangeToIsland: (_peerId: string, _island: Island, _change: ChangeToIslandUpdate) => {}
    }
    engine = createArchipelagoEngine({
      components: { logs, metrics, publisher },
      joinDistance: 64,
      leaveDistance: 80,
      flushFrequency: 2
    })

    engine.onTransportHeartbeat({
      id: 0,
      type: 'p2p',
      availableSeats: 500,
      usersCount: 0,
      maxIslandSize: 200,
      getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
        const connStrs: Record<string, string> = {}
        for (const userId of userIds) {
          connStrs[userId] = `p2p:${roomId}.${userId}`
        }
        return Promise.resolve(connStrs)
      }
    })
  })

  function setPositionArrays(...positions: PositionWithId[]) {
    engine.onPeerPositionsUpdate(positions.map(([id, ...position]) => ({ id, position })))
    return engine.flush()
  }

  it('joins two close peers in island', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16])

    expect.strictEqual(engine.getIslands().length, 1)
    expectIslandWith(engine, '1', '2')
  })

  it('avoids joining a peer that is far away', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 200, 0, 200])

    const islands = engine.getIslands()

    expect.strictEqual(islands.length, 2)
    expectIslandsWith(engine, ['1', '2'], ['3'])
  })

  it("joins two existing islands when a peer 'bridges' them", async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 100, 0, 0])

    expect.strictEqual(engine.getIslands().length, 2)
    expectIslandsWith(engine, ['1', '2'], ['3'])

    await setPositionArrays(['4', 50, 0, 0])

    expect.strictEqual(engine.getIslands().length, 1)

    expectIslandWith(engine, '1', '2', '3', '4')
  })

  it('splits islands when a peer leaves', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0])
    expectIslandWith(engine, '1', '2', '3')

    await setPositionArrays(['3', 100, 0, 0])

    expectIslandsWith(engine, ['1', '2'], ['3'])
  })

  it('splits islands when a group of peers leaves', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0], ['4', 45, 0, 0])
    expectIslandWith(engine, '1', '2', '3', '4')

    await setPositionArrays(['3', 100, 0, 0], ['4', 95, 0, 0])

    expectIslandsWith(engine, ['1', '2'], ['3', '4'])
  })

  it('respects join & leave radiuses for stability', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0], ['4', 45, 0, 0])
    expectIslandWith(engine, '1', '2', '3', '4')

    await setPositionArrays(['5', -100, 0, 0], ['6', -105, 0, 0])

    expectIslandsWith(engine, ['1', '2', '3', '4'], ['5', '6'])

    await setPositionArrays(['5', -50, 0, 0])

    expectIslandWith(engine, '1', '2', '3', '4', '5', '6')

    await setPositionArrays(['5', -70, 0, 0])
    expectIslandWith(engine, '1', '2', '3', '4', '5', '6')

    await setPositionArrays(['5', -85, 0, 0])

    expectIslandsWith(engine, ['1', '2', '3', '4'], ['5', '6'])
  })

  it('keeps biggest island id when splitting', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0], ['4', 45, 0, 0])
    const islandId = engine.getIslands()[0].id

    await setPositionArrays(['3', 150, 0, 0])

    const island = engine.getIsland(islandId)

    expect.notStrictEqual(island!.peers.map((it) => it.id).sort(), ['1', '2', '4'])

    expectIslandWith(engine, '3')
  })

  it('can clear a peer', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['4', 50, 0, 0], ['3', 100, 0, 0])

    expectIslandsWith(engine, ['1', '2', '3', '4'])

    engine.onPeerDisconnected('4')
    await engine.flush()

    expectIslandsWith(engine, ['1', '2'], ['3'])
  })

  it('can add a peer again after it has been cleared', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16])

    expectIslandsWith(engine, ['1', '2'])

    engine.onPeerDisconnected('1')
    engine.onPeerDisconnected('2')
    await engine.flush()

    await setPositionArrays(['1', 0, 0, 0])

    expectIslandsWith(engine, ['1'])
  })

  function expectChangedTo(updates: IslandUpdates, peerId: string, islandId: string, fromIslandId?: string) {
    expect.strictEqual(updates.get(peerId)!.islandId, islandId)
    expect.strictEqual(updates.get(peerId)!.action, 'changeTo')
    if (fromIslandId) {
      expect.strictEqual((updates.get(peerId) as ChangeToIslandUpdate).fromIslandId, fromIslandId)
    }
  }

  function expectLeft(updates: IslandUpdates, peerId: string, islandId: string) {
    expect.strictEqual(updates.get(peerId).islandId, islandId)
    expect.strictEqual(updates.get(peerId).action, 'leave')
  }

  function expectNoUpdate(updates: IslandUpdates, peerId: string) {
    expect.strictEqual(typeof updates.get(peerId), 'undefined')
  }

  it('provides updates when setting positions', async () => {
    engine.onPeerPositionsUpdate([{ id: '0', position: [15, 0, 0] }])
    let updates = await engine.flush()

    expectChangedTo(updates, '0', 'I1')
    engine.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
    updates = await engine.flush()
    expectChangedTo(updates, '1', 'I1')
    expectNoUpdate(updates, '0')

    engine.onPeerPositionsUpdate([{ id: '2', position: [100, 0, 0] }])
    updates = await engine.flush()

    expectChangedTo(updates, '2', 'I3')
    expectNoUpdate(updates, '1')
    expectNoUpdate(updates, '0')

    engine.onPeerPositionsUpdate([{ id: '3', position: [50, 0, 0] }])
    updates = await engine.flush()

    expectChangedTo(updates, '2', 'I1', 'I3')
    expectChangedTo(updates, '3', 'I1')
    expectNoUpdate(updates, '1')
    expectNoUpdate(updates, '0')
  })

  it('provides updates when clearing peer', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 50, 0, 0], ['3', 100, 0, 0])

    expectIslandsWith(engine, ['1', '2', '3'])
    engine.onPeerDisconnected('2')

    const updates = await engine.flush()

    expectLeft(updates, '2', 'I1')
    expectChangedTo(updates, '3', 'I4', 'I1')
    expectNoUpdate(updates, '1')
  })

  it('calculates island geometry', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 40, 0, 40])

    const island = engine.getIslands()[0]

    expect.deepStrictEqual(island.center, [20, 0, 20])
    expect(Math.abs(island.radius - Math.sqrt(800)) < 0.0000001) // Distance between center and farthest peer
  })

  it('sets radius to encompass all peers', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 10], ['3', 6, 0, 6], ['4', 40, 0, 40])

    const island = engine.getIslands()[0]

    expect.deepStrictEqual(island.center, [14, 0, 14])
    expect(Math.abs(island.radius - Math.sqrt(1352)) < 0.0000001)
  })

  it('enforces max peers per island limit', async () => {
    const idGenerator = sequentialIdGenerator('P')
    expect.strictEqual(engine.getIslands().length, 0)
    const firstRequests = await setMultiplePeersAround(engine, [0, 0, 0], 190, idGenerator)

    expect.strictEqual(engine.getIslands().length, 1)
    expectIslandWith(engine, ...firstRequests.map((it) => it.id))

    const peerRequests = await setMultiplePeersAround(engine, [100, 0, 0], 20, idGenerator)

    expect.strictEqual(engine.getIslands().length, 2)
    expectIslandWith(engine, ...peerRequests.map((it) => it.id))

    await setPositionArrays(
      ...peerRequests.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    expect.strictEqual(engine.getIslands().length, 2)
    expectIslandWith(engine, ...firstRequests.map((it) => it.id))
    expectIslandWith(engine, ...peerRequests.map((it) => it.id))

    peerRequests.slice(0, 10).forEach((it) => engine.onPeerDisconnected(it.id))
    await engine.flush()

    expect.strictEqual(engine.getIslands().length, 1)
    expectIslandWith(engine, ...firstRequests.map((it) => it.id), ...peerRequests.slice(10, 20).map((it) => it.id))
  })

  it('merges with the biggest island available', async () => {
    const idGenerator = sequentialIdGenerator('P')
    const superBigIsland = await setMultiplePeersAround(engine, [0, 0, 0], 190, idGenerator)
    const bigIsland = await setMultiplePeersAround(engine, [100, 0, 0], 150, idGenerator)
    const smallIsland = await setMultiplePeersAround(engine, [200, 0, 0], 100, idGenerator)

    await setPositionArrays(
      ...bigIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    await setPositionArrays(
      ...smallIsland.map((it) => [it.id, it.position[0] - 200, it.position[1], it.position[2]] as PositionWithId)
    )

    expect.strictEqual(engine.getIslands().length, 3)

    await setPositionArrays(['newPeer', 0, 0, 0])
    expect.strictEqual(engine.getIslands().length, 3)

    expectIslandWith(engine, 'newPeer', ...superBigIsland.map((it) => it.id))

    const smallestIsland = await setMultiplePeersAround(engine, [100, 0, 0], 20, idGenerator)

    await setPositionArrays(
      ...smallestIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    expectIslandWith(engine, ...smallestIsland.map((it) => it.id), ...bigIsland.map((it) => it.id))
  })

  function getIslandId(changes: PeerPositionChange[]) {
    const peerData = engine.getPeerData(changes[0].id)
    return engine.getIsland(peerData?.islandId!)?.id!
  }

  it('merges islands considering the preferedIsland for single peers', async () => {
    function getIslandId(changes: PeerPositionChange[]) {
      const peerData = engine.getPeerData(changes[0].id)
      return engine.getIsland(peerData?.islandId!)?.id!
    }

    const idGenerator = sequentialIdGenerator('P')
    const superBigIsland = await setMultiplePeersAround(engine, [0, 0, 0], 190, idGenerator)
    const bigIsland = await setMultiplePeersAround(engine, [100, 0, 0], 150, idGenerator)
    const smallIsland = await setMultiplePeersAround(engine, [200, 0, 0], 100, idGenerator)

    await setPositionArrays(
      ...bigIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    await setPositionArrays(
      ...smallIsland.map((it) => [it.id, it.position[0] - 200, it.position[1], it.position[2]] as PositionWithId)
    )

    engine.onPeerPositionsUpdate([{ id: 'peer1', position: [0, 0, 0] }])
    let updates = await engine.flush()

    expectChangedTo(updates, 'peer1', getIslandId(superBigIsland))

    engine.onPeerPositionsUpdate([{ id: 'peer2', position: [0, 0, 0], preferedIslandId: getIslandId(bigIsland) }])
    updates = await engine.flush()

    expectChangedTo(updates, 'peer2', getIslandId(bigIsland))

    engine.onPeerPositionsUpdate([{ id: 'peer3', position: [0, 0, 0], preferedIslandId: getIslandId(smallIsland) }])
    updates = await engine.flush()

    expectChangedTo(updates, 'peer3', getIslandId(smallIsland))
  })

  it('merges islands considering the preferedIsland for multiple peers even when set before', async () => {
    const idGenerator = sequentialIdGenerator('P')
    await setMultiplePeersAround(engine, [0, 0, 0], 190, idGenerator)
    const bigIsland = await setMultiplePeersAround(engine, [100, 0, 0], 150, idGenerator)

    await setPositionArrays(
      ...bigIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    engine.onPeerPositionsUpdate([
      { id: 'peer1', position: [100, 0, 0], preferedIslandId: getIslandId(bigIsland) },
      { id: 'peer2', position: [100, 0, 0] }
    ])

    let updates = await engine.flush()
    expectIslandWith(engine, 'peer1', 'peer2')

    expect.notStrictEqual(updates.get('peer1').islandId, getIslandId(bigIsland))

    updates = await setPositionArrays(['peer1', 0, 0, 0], ['peer2', 0, 0, 0])

    expect.strictEqual(updates.get('peer1').islandId, getIslandId(bigIsland))
    expect.strictEqual(updates.get('peer2').islandId, getIslandId(bigIsland))
  })
})
