import { Island, PeerPositionChange, Position3D, ChangeToIslandUpdate } from '../../src/types'
import { ArchipelagoController } from '../../src/controllers/archipelago'
import { BaseClosure, evaluate } from 'tiny-clojure'
import { NodeError } from 'tiny-clojure/dist/types'
import assert from 'assert'
import get from 'lodash.get'
import { createRandomizer } from '../helpers/random'
import { IdGenerator, sequentialIdGenerator } from '../../src/misc/idGenerator'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createPeersRegistry } from '../../src/adapters/peers-registry'
import { createConfigComponent } from '@well-known-components/env-config-provider'

export function expectIslandWith(archipelago: ArchipelagoController, ...ids: string[]) {
  assert(Array.isArray(ids))
  assert('getIslands' in archipelago)
  const islands = archipelago.getIslands()
  expectIslandWithPeerIdsIn(ids, islands)
}

function expectIslandWithPeerIdsIn(ids: string[], islands: Island[]) {
  const sortedIds = ids.sort()
  const condition = islands.some((it) => deepEqual(it.peers.map((peer) => peer.id).sort(), sortedIds))
  if (!condition) {
    throw new Error(
      '\nThere are no islands with the peers:\n  ' +
        JSON.stringify(sortedIds) +
        '\nIslands have:\n' +
        islands.map((it) => '  ' + it.id + ' -> ' + JSON.stringify(it.peers.map((peer) => peer.id).sort())).join('\n')
    )
  }
}

export function expectIslandsWith(archipelago: ArchipelagoController, ...islandIds: string[][]) {
  assert('getIslands' in archipelago)
  assert(Array.isArray(islandIds))
  islandIds.forEach((ids) => expectIslandWith(archipelago, ...ids))
  assert.strictEqual(archipelago.getIslands().length, islandIds.length)
}

export async function expectIslandInControllerWith(archipelago: ArchipelagoController, ...peerIds: string[]) {
  expectIslandWithPeerIdsIn(peerIds, archipelago.getIslands())
}

export async function expectIslandsInControllerWith(archipelago: ArchipelagoController, ...peerGroups: string[][]) {
  await Promise.all(peerGroups.map((ids) => expectIslandInControllerWith(archipelago, ...ids)))
}

export function expectIslandsCount(archipelago: ArchipelagoController, count: number) {
  assert.strictEqual(archipelago.getIslands().length, count)
}

export async function setMultiplePeersAround(
  archipelago: ArchipelagoController,
  position: Position3D,
  qty: number,
  idGenerator: IdGenerator = sequentialIdGenerator('P'),
  offset: Position3D = [10, 0, 10]
) {
  const randomizer = createRandomizer()
  const requests: PeerPositionChange[] = []
  for (let i = 0; i < qty; i++) {
    requests.push({ id: idGenerator.generateId(), position: randomizer.generatePositionAround(position, offset) })
  }

  archipelago.onPeerPositionsUpdate(requests)
  await archipelago.flush()

  return requests
}

export function configureLibs(closure: BaseClosure) {
  // (configure { options })
  closure.defJsFunction('configure', async () => {
    const config = createConfigComponent({ LOG_LEVEL: 'INFO' })
    const logs = await createLogComponent({ config })
    const metrics = createTestMetricsComponent(metricDeclarations)
    const peersRegistry = await createPeersRegistry({
      publish: (_topic: string, _payload: Uint8Array, _binary: boolean) => {}
    })
    const publisher = {
      onChangeToIsland: (_peerId: string, _island: Island, _change: ChangeToIslandUpdate) => {}
    }
    const archipelago = new ArchipelagoController({
      components: { logs, peersRegistry, metrics, publisher },
      joinDistance: 64,
      leaveDistance: 80
    })

    archipelago.onTransportHeartbeat({
      id: 0,
      type: 'p2p',
      availableSeats: 300,
      usersCount: 0,
      maxIslandSize: 100,
      getConnectionStrings: (userIds: string[], roomId: string): Promise<Record<string, string>> => {
        const connStrs: Record<string, string> = {}
        for (const userId of userIds) {
          connStrs[userId] = `p2p:${roomId}.${userId}`
        }
        return Promise.resolve(connStrs)
      }
    })

    closure.def('archipelago', archipelago)
  })

  closure.defJsFunction('configureTransports', (args: [number, number, number, number][]) => {
    const archipelago = closure.get('archipelago') as ArchipelagoController

    for (const [id, availableSeats, usersCount, maxIslandSize] of args) {
      archipelago.onTransportHeartbeat({
        id,
        type: 'p2p',
        availableSeats,
        usersCount,
        maxIslandSize,
        getConnectionStrings: (userIds: string[], roomId: string): Promise<Record<string, string>> => {
          const connStrs: Record<string, string> = {}
          for (const userId of userIds) {
            connStrs[userId] = `p2p:${roomId}.${userId}`
          }
          return Promise.resolve(connStrs)
        }
      })
    }

    return archipelago.flush()
  })

  closure.defJsFunction('removeTransports', (args: number[]) => {
    const archipelago = closure.get('archipelago') as ArchipelagoController

    for (const id of args) {
      archipelago.onTransportDisconnected(id)
    }

    return archipelago.flush()
  })

  // (move ...[peer x y z])
  closure.defJsFunction('move', (...args: [string, number, number, number][]) => {
    const archipelago = closure.get('archipelago') as ArchipelagoController
    archipelago.onPeerPositionsUpdate(args.map(([id, ...position]) => ({ id, position })))
    return archipelago.flush()
  })

  // (getIslands archipelago?)
  closure.defJsFunction('getIslands', (arch) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    return archipelago.getIslands()
  })

  // (getIsland id archipelago?)
  closure.defJsFunction('getIsland', (id, arch?) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    console.assert(typeof id == 'string', 'getIsland(islandId) islandId must be a string')
    return archipelago.getIsland(id)
  })

  // (expectIslandWith [...ids] arch?)
  closure.defJsFunction('expectIslandWith', (ids, arch) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    expectIslandWith(archipelago, ...ids)
  })

  // (expectIslandsWith [...ids] arch?)
  closure.defJsFunction('expectIslandsWith', (ids, arch) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    expectIslandsWith(archipelago, ...ids)
  })

  // (ensureIslandsCount count arch?)
  closure.defJsFunction('ensureIslandsCount', (count: number, arch) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    expectIslandsCount(archipelago, count)
  })

  closure.defJsFunction('ensureIslandsCountWithTransport', (expectedCount: number, transportId: number, arch) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    let count = 0
    for (const island of archipelago.getIslands()) {
      if (transportId === island.transportId) {
        count++
      }
    }
    assert(expectedCount === count)
  })

  // (disconnect [...ids] arch?)
  closure.defJsFunction('disconnect', async (ids, arch) => {
    const archipelago = (arch || closure.get('archipelago')) as ArchipelagoController
    if (typeof ids == 'string') {
      archipelago.onPeerDisconnected(ids)
      const updates = await archipelago.flush()
      assert(updates.get(ids).action === 'leave', `Peer ${ids} must be deleted`)
    } else if (Array.isArray(ids)) {
      ids.forEach((id) => archipelago.onPeerDisconnected(id))
      const updates = await archipelago.flush()
      ids.forEach(($: any) => assert(updates.get($).action === 'leave', `Peer ${$} must be deleted`))
    } else {
      throw new Error('Invalid argument')
    }
  })

  // (get obj ...path)
  closure.defJsFunction('get', (obj, ...path: string[]) => {
    return get(obj, path)
  })

  closure.defJsFunction('echo', (args: any) => {
    console.log(args)
  })

  // (* ...args)
  closure.defJsFunction('*', async function (...args: any[]) {
    return args.reduce((a, b) => a * b, 1)
  })

  // (+ ...args)
  closure.defJsFunction('+', async function (...args: any[]) {
    return args.reduce((a, b) => a + b, 0)
  })

  // (- ...args)
  closure.defJsFunction('-', async function (...args: any[]) {
    return args.reduce((a, b) => a - b)
  })

  // (/ ...args)
  closure.defJsFunction('/', async function (...args: any[]) {
    return args.reduce((a, b) => a / b)
  })

  // (= a b)
  closure.defJsFunction('=', async function (a, b) {
    assert.deepStrictEqual(arguments.length, 2, '(= a b) requires exactly two arguments')
    return deepEqual(a, b)
  })

  // (not a)
  closure.defJsFunction('not', async function (a) {
    assert.deepStrictEqual(arguments.length, 1, '(not arg) requires exactly one argument, got: ' + arguments.length)
    return !a
  })

  // (assert/equal a b)
  closure.defJsFunction('assert/equal', async function (a, b) {
    assert.deepStrictEqual(arguments.length, 2, 'assert/equal requires exactly two arguments')
    assert.deepStrictEqual(a, b)
    return true
  })

  // (assert/notEqual a b)
  closure.defJsFunction('assert/notEqual', async function (a, b) {
    assert.strictEqual(arguments.length, 2, 'assert/notEqual requires exactly two arguments')
    assert.notDeepStrictEqual(a, b)
    return true
  })

  // (assert/throws ...assertions)
  closure.defn('assert/throws', async (node, assertions, closure) => {
    for (let assertion of assertions) {
      await assert.rejects(async () => {
        await evaluate(assertion, closure)
      }, new NodeError("The assertion didn't fail", assertion))
    }
    return true
  })

  // (assert "name" condition)
  closure.defJsFunction('throwIf', async function (condition) {
    if (condition) {
      throw new Error('bla')
    }
  })

  // (assert "name" condition)
  closure.defJsFunction('assert', async function (name, condition) {
    assert(condition, name)
  })

  // (test ...assertions)
  // (test "name" ...assertions)
  closure.defn('test', async (node, args, closure) => {
    const assertions = args.slice()
    let name = 'Anonymus assertion'

    if (assertions.length && assertions[0].type == 'String') {
      name = assertions.shift()!.text
    }

    try {
      for (let assertion of assertions) {
        await evaluate(assertion, closure)
      }
    } catch (e) {
      e.message = e.message + `\nat: ${name} assertion`
      throw e
    }
  })
}

export function delay(time: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, time))
}

export async function whileTrue(
  condition: () => boolean,
  messageIfFailed: string = 'no message specified',
  timeout: number = 1000
) {
  const started = Date.now()
  while (condition()) {
    if (Date.now() - started > timeout) {
      throw new Error('Timed out awaiting condition: ' + messageIfFailed)
    }
    await delay(5)
  }
}

export async function untilTrue(
  condition: () => boolean,
  messageIfFailed: string = 'no message specified',
  timeout: number = 1000
) {
  await whileTrue(() => !condition(), messageIfFailed, timeout)
}

export function deepEqual(x: any, y: any) {
  if (x === y) {
    return true
  } else if (typeof x == 'object' && x != null && typeof y == 'object' && y != null) {
    if (Object.keys(x).length != Object.keys(y).length) return false

    for (var prop in x) {
      if (y.hasOwnProperty(prop)) {
        if (!deepEqual(x[prop], y[prop])) return false
      } else return false
    }

    return true
  } else return false
}
