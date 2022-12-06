import { ArchipelagoController } from '../../src/controllers/archipelago'

import expect from 'assert'
import { PeerPositionChange, IslandUpdates, ChangeToIslandUpdate, Island } from '../../src/types'
import { sequentialIdGenerator } from '../../src/misc/idGenerator'
import { expectIslandsWith, expectIslandWith, setMultiplePeersAround } from '../helpers/archipelago'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'

type PositionWithId = [string, number, number, number]

describe('archipelago', () => {
  let archipelago: ArchipelagoController
  beforeEach(async () => {
    const publisher = {
      onChangeToIsland: (peerId: string, island: Island, change: ChangeToIslandUpdate) => {},
      onPeerLeft: (peerId: string, islandId: string) => {}
    }

    const logs = await createLogComponent({})
    const metrics = createTestMetricsComponent(metricDeclarations)

    archipelago = new ArchipelagoController({
      components: { logs, publisher, metrics },
      joinDistance: 64,
      leaveDistance: 80
    })

    archipelago.onTransportHeartbeat({
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
    archipelago.onPeerPositionsUpdate(positions.map(([id, ...position]) => ({ id, position })))
    return archipelago.flush()
  }

  it('joins two close peers in island', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16])

    expect.strictEqual(archipelago.getIslands().length, 1)
    expectIslandWith(archipelago, '1', '2')
  })

  it('avoids joining a peer that is far away', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 200, 0, 200])

    const islands = archipelago.getIslands()

    expect.strictEqual(islands.length, 2)
    expectIslandsWith(archipelago, ['1', '2'], ['3'])
  })

  it("joins two existing islands when a peer 'bridges' them", async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 100, 0, 0])

    expect.strictEqual(archipelago.getIslands().length, 2)
    expectIslandsWith(archipelago, ['1', '2'], ['3'])

    await setPositionArrays(['4', 50, 0, 0])

    expect.strictEqual(archipelago.getIslands().length, 1)

    expectIslandWith(archipelago, '1', '2', '3', '4')
  })

  it('splits islands when a peer leaves', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0])
    expectIslandWith(archipelago, '1', '2', '3')

    await setPositionArrays(['3', 100, 0, 0])

    expectIslandsWith(archipelago, ['1', '2'], ['3'])
  })

  it('splits islands when a group of peers leaves', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0], ['4', 45, 0, 0])
    expectIslandWith(archipelago, '1', '2', '3', '4')

    await setPositionArrays(['3', 100, 0, 0], ['4', 95, 0, 0])

    expectIslandsWith(archipelago, ['1', '2'], ['3', '4'])
  })

  it('respects join & leave radiuses for stability', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0], ['4', 45, 0, 0])
    expectIslandWith(archipelago, '1', '2', '3', '4')

    await setPositionArrays(['5', -100, 0, 0], ['6', -105, 0, 0])

    expectIslandsWith(archipelago, ['1', '2', '3', '4'], ['5', '6'])

    await setPositionArrays(['5', -50, 0, 0])

    expectIslandWith(archipelago, '1', '2', '3', '4', '5', '6')

    await setPositionArrays(['5', -70, 0, 0])
    expectIslandWith(archipelago, '1', '2', '3', '4', '5', '6')

    await setPositionArrays(['5', -85, 0, 0])

    expectIslandsWith(archipelago, ['1', '2', '3', '4'], ['5', '6'])
  })

  it('keeps biggest island id when splitting', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['3', 50, 0, 0], ['4', 45, 0, 0])
    const islandId = archipelago.getIslands()[0].id

    await setPositionArrays(['3', 150, 0, 0])

    const island = archipelago.getIsland(islandId)

    expect.notStrictEqual(island!.peers.map((it) => it.id).sort(), ['1', '2', '4'])

    expectIslandWith(archipelago, '3')
  })

  it('can clear a peer', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16], ['4', 50, 0, 0], ['3', 100, 0, 0])

    expectIslandsWith(archipelago, ['1', '2', '3', '4'])

    archipelago.onPeerRemoved('4')
    await archipelago.flush()

    expectIslandsWith(archipelago, ['1', '2'], ['3'])
  })

  it('can add a peer again after it has been cleared', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 16, 0, 16])

    expectIslandsWith(archipelago, ['1', '2'])

    archipelago.onPeerRemoved('1')
    archipelago.onPeerRemoved('2')
    await archipelago.flush()

    await setPositionArrays(['1', 0, 0, 0])

    expectIslandsWith(archipelago, ['1'])
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
    archipelago.onPeerPositionsUpdate([{ id: '0', position: [15, 0, 0] }])
    let updates = await archipelago.flush()

    expectChangedTo(updates, '0', 'I1')
    archipelago.onPeerPositionsUpdate([{ id: '1', position: [0, 0, 0] }])
    updates = await archipelago.flush()
    expectChangedTo(updates, '1', 'I1')
    expectNoUpdate(updates, '0')

    archipelago.onPeerPositionsUpdate([{ id: '2', position: [100, 0, 0] }])
    updates = await archipelago.flush()

    expectChangedTo(updates, '2', 'I3')
    expectNoUpdate(updates, '1')
    expectNoUpdate(updates, '0')

    archipelago.onPeerPositionsUpdate([{ id: '3', position: [50, 0, 0] }])
    updates = await archipelago.flush()

    expectChangedTo(updates, '2', 'I1', 'I3')
    expectChangedTo(updates, '3', 'I1')
    expectNoUpdate(updates, '1')
    expectNoUpdate(updates, '0')
  })

  it('provides updates when clearing peer', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 50, 0, 0], ['3', 100, 0, 0])

    expectIslandsWith(archipelago, ['1', '2', '3'])
    archipelago.onPeerRemoved('2')

    const updates = await archipelago.flush()

    expectLeft(updates, '2', 'I1')
    expectChangedTo(updates, '3', 'I4', 'I1')
    expectNoUpdate(updates, '1')
  })

  it('calculates island geometry', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 40, 0, 40])

    const island = archipelago.getIslands()[0]

    expect.deepStrictEqual(island.center, [20, 0, 20])
    expect(Math.abs(island.radius - Math.sqrt(800)) < 0.0000001) // Distance between center and farthest peer
  })

  it('sets radius to encompass all peers', async () => {
    await setPositionArrays(['1', 0, 0, 0], ['2', 10, 0, 10], ['3', 6, 0, 6], ['4', 40, 0, 40])

    const island = archipelago.getIslands()[0]

    expect.deepStrictEqual(island.center, [14, 0, 14])
    expect(Math.abs(island.radius - Math.sqrt(1352)) < 0.0000001)
  })

  it('enforces max peers per island limit', async () => {
    const idGenerator = sequentialIdGenerator('P')
    expect.strictEqual(archipelago.getIslands().length, 0)
    const firstRequests = await setMultiplePeersAround(archipelago, [0, 0, 0], 190, idGenerator)

    expect.strictEqual(archipelago.getIslands().length, 1)
    expectIslandWith(archipelago, ...firstRequests.map((it) => it.id))

    const peerRequests = await setMultiplePeersAround(archipelago, [100, 0, 0], 20, idGenerator)

    expect.strictEqual(archipelago.getIslands().length, 2)
    expectIslandWith(archipelago, ...peerRequests.map((it) => it.id))

    await setPositionArrays(
      ...peerRequests.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    expect.strictEqual(archipelago.getIslands().length, 2)
    expectIslandWith(archipelago, ...firstRequests.map((it) => it.id))
    expectIslandWith(archipelago, ...peerRequests.map((it) => it.id))

    peerRequests.slice(0, 10).forEach((it) => archipelago.onPeerRemoved(it.id))
    await archipelago.flush()

    expect.strictEqual(archipelago.getIslands().length, 1)
    expectIslandWith(archipelago, ...firstRequests.map((it) => it.id), ...peerRequests.slice(10, 20).map((it) => it.id))
  })

  it('merges with the biggest island available', async () => {
    const idGenerator = sequentialIdGenerator('P')
    const superBigIsland = await setMultiplePeersAround(archipelago, [0, 0, 0], 190, idGenerator)
    const bigIsland = await setMultiplePeersAround(archipelago, [100, 0, 0], 150, idGenerator)
    const smallIsland = await setMultiplePeersAround(archipelago, [200, 0, 0], 100, idGenerator)

    await setPositionArrays(
      ...bigIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    await setPositionArrays(
      ...smallIsland.map((it) => [it.id, it.position[0] - 200, it.position[1], it.position[2]] as PositionWithId)
    )

    expect.strictEqual(archipelago.getIslands().length, 3)

    await setPositionArrays(['newPeer', 0, 0, 0])
    expect.strictEqual(archipelago.getIslands().length, 3)

    expectIslandWith(archipelago, 'newPeer', ...superBigIsland.map((it) => it.id))

    const smallestIsland = await setMultiplePeersAround(archipelago, [100, 0, 0], 20, idGenerator)

    await setPositionArrays(
      ...smallestIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    expectIslandWith(archipelago, ...smallestIsland.map((it) => it.id), ...bigIsland.map((it) => it.id))
  })

  function getIslandId(changes: PeerPositionChange[]) {
    const peerData = archipelago.getPeerData(changes[0].id)
    return archipelago.getIsland(peerData?.islandId!)?.id!
  }

  it('merges islands considering the preferedIsland for single peers', async () => {
    function getIslandId(changes: PeerPositionChange[]) {
      const peerData = archipelago.getPeerData(changes[0].id)
      return archipelago.getIsland(peerData?.islandId!)?.id!
    }

    const idGenerator = sequentialIdGenerator('P')
    const superBigIsland = await setMultiplePeersAround(archipelago, [0, 0, 0], 190, idGenerator)
    const bigIsland = await setMultiplePeersAround(archipelago, [100, 0, 0], 150, idGenerator)
    const smallIsland = await setMultiplePeersAround(archipelago, [200, 0, 0], 100, idGenerator)

    await setPositionArrays(
      ...bigIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    await setPositionArrays(
      ...smallIsland.map((it) => [it.id, it.position[0] - 200, it.position[1], it.position[2]] as PositionWithId)
    )

    archipelago.onPeerPositionsUpdate([{ id: 'peer1', position: [0, 0, 0] }])
    let updates = await archipelago.flush()

    expectChangedTo(updates, 'peer1', getIslandId(superBigIsland))

    archipelago.onPeerPositionsUpdate([{ id: 'peer2', position: [0, 0, 0], preferedIslandId: getIslandId(bigIsland) }])
    updates = await archipelago.flush()

    expectChangedTo(updates, 'peer2', getIslandId(bigIsland))

    archipelago.onPeerPositionsUpdate([
      { id: 'peer3', position: [0, 0, 0], preferedIslandId: getIslandId(smallIsland) }
    ])
    updates = await archipelago.flush()

    expectChangedTo(updates, 'peer3', getIslandId(smallIsland))
  })

  it('merges islands considering the preferedIsland for multiple peers even when set before', async () => {
    const idGenerator = sequentialIdGenerator('P')
    await setMultiplePeersAround(archipelago, [0, 0, 0], 190, idGenerator)
    const bigIsland = await setMultiplePeersAround(archipelago, [100, 0, 0], 150, idGenerator)

    await setPositionArrays(
      ...bigIsland.map((it) => [it.id, it.position[0] - 100, it.position[1], it.position[2]] as PositionWithId)
    )

    archipelago.onPeerPositionsUpdate([
      { id: 'peer1', position: [100, 0, 0], preferedIslandId: getIslandId(bigIsland) },
      { id: 'peer2', position: [100, 0, 0] }
    ])

    let updates = await archipelago.flush()
    expectIslandWith(archipelago, 'peer1', 'peer2')

    expect.notStrictEqual(updates.get('peer1').islandId, getIslandId(bigIsland))

    updates = await setPositionArrays(['peer1', 0, 0, 0], ['peer2', 0, 0, 0])

    expect.strictEqual(updates.get('peer1').islandId, getIslandId(bigIsland))
    expect.strictEqual(updates.get('peer2').islandId, getIslandId(bigIsland))
  })
})
