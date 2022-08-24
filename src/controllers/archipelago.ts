import {
  PeerData,
  Position3D,
  Island,
  PeerPositionChange,
  Transport,
  BaseComponents,
  ChangeToIslandUpdate,
  LeaveIslandUpdate,
  IslandUpdates
} from '../types'

import { findMax, popMax } from '../misc/utils'
import { IdGenerator, sequentialIdGenerator } from '../misc/idGenerator'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { IPublisherComponent } from '../ports/publisher'

type Publisher = Pick<IPublisherComponent, 'onPeerLeft' | 'onChangeToIsland'>

export type Options = {
  components: Pick<BaseComponents, 'logs'> & {
    publisher: Publisher
  }
  flushFrequency?: number
  parameters: {
    joinDistance: number
    leaveDistance: number
  }
}

const X_AXIS = 0
const Z_AXIS = 2

const squaredDistance = (p1: Position3D, p2: Position3D) => {
  // By default, we use XZ plane squared distance. We ignore "height"
  const xDiff = p2[X_AXIS] - p1[X_AXIS]
  const zDiff = p2[Z_AXIS] - p1[Z_AXIS]

  return xDiff * xDiff + zDiff * zDiff
}

function islandGeometryCalculator(peers: PeerData[]): [Position3D, number] {
  if (peers.length === 0) return [[0, 0, 0], 0]
  const sum = peers.reduce<Position3D>(
    (current, peer) => [current[X_AXIS] + peer.position[X_AXIS], 0, current[Z_AXIS] + peer.position[Z_AXIS]],
    [0, 0, 0]
  )

  const center = sum.map((it) => it / peers.length) as Position3D
  const farthest = findMax(peers, (peer) => squaredDistance(peer.position, center))!

  const radius = Math.sqrt(squaredDistance(farthest.position, center))

  return [center, radius]
}

function recalculateGeometryIfNeeded(island: Island) {
  if (island.peers.length > 0 && (island._geometryDirty || !island._radius || !island._center)) {
    const [center, radius] = islandGeometryCalculator(island.peers)
    island._center = center
    island._radius = radius
    island._geometryDirty = false
  }
}

function squared(n: number) {
  return n * n
}

export class ArchipelagoController {
  private transports = new Map<number, Transport>()
  private peers: Map<string, PeerData> = new Map()
  private islands: Map<string, Island> = new Map()
  private currentSequence: number = 0
  private joinDistance: number
  private leaveDistance: number
  private islandIdGenerator = sequentialIdGenerator('I')
  private publisher: Publisher

  private pendingNewPeers = new Map<string, PeerData>()
  private pendingUpdates = new Map<string, ChangeToIslandUpdate | LeaveIslandUpdate>()

  flushFrequency: number
  logger: ILoggerComponent.ILogger

  requestIdGenerator: IdGenerator = sequentialIdGenerator('')

  disposed: boolean = false

  constructor({
    components: { logs, publisher },
    flushFrequency,
    parameters: { joinDistance, leaveDistance }
  }: Options) {
    this.logger = logs.getLogger('Archipelago')
    this.publisher = publisher

    this.flushFrequency = flushFrequency ?? 2
    this.joinDistance = joinDistance
    this.leaveDistance = leaveDistance

    this.transports.set(0, {
      id: 0,
      availableSeats: 0,
      usersCount: 0,
      maxIslandSize: 100,
      async getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>> {
        const connStrs: Record<string, string> = {}
        for (const userId of userIds) {
          connStrs[userId] = `p2p:${roomId}:${userId}`
        }
        return connStrs
      }
    })

    const loop = () => {
      if (!this.disposed) {
        const startTime = Date.now()
        this.flush().catch((err) => {
          this.logger.error(err)
        })
        const flushElapsed = Date.now() - startTime
        setTimeout(loop, Math.max(this.flushFrequency * 1000 - flushElapsed), 1) // At least 1 ms between flushes
      }
    }

    loop()
  }

  onTransportConnected(transport: Transport): void {
    this.transports.set(transport.id, transport)
  }

  onTransportDisconnected(id: number): void {
    this.transports.delete(id)
    // NOTE(hugo): we don't recreate islands, this will happen naturally if
    // the transport is actually down, but we don't want to assign new peers
    // there
    for (const island of this.islands.values()) {
      if (island.transportId === id) {
        island.maxPeers = 0
      }
    }
  }

  onPeerPositionsUpdate(changes: PeerPositionChange[]): void {
    for (const change of changes) {
      const { id, position, preferedIslandId } = change
      if (!this.peers.has(id)) {
        this.pendingNewPeers.set(id, change)
      } else {
        const peer = this.peers.get(id)!
        peer.position = position

        // We can set the prefered island to undefined by explicitly providing the key but no value.
        // If we don't provide the key, we leave it as it is
        if ('preferedIslandId' in change) {
          peer.preferedIslandId = preferedIslandId
        }

        if (peer.islandId) {
          const island = this.islands.get(peer.islandId)!
          island._geometryDirty = true
        }
      }
    }
  }

  getIslands(): Island[] {
    return Array.from(this.islands.values())
  }

  getIsland(id: string): Island | undefined {
    return this.islands.get(id)
  }

  getPeerData(id: string): PeerData | undefined {
    return this.peers.get(id)
  }

  onPeerRemoved(id: string): void {
    const peer = this.peers.get(id)

    if (peer) {
      this.peers.delete(id)
      if (peer.islandId) {
        const island = this.islands.get(peer.islandId)!

        const idx = island.peers.findIndex((it) => it.id === id)
        if (idx >= 0) {
          island.peers.splice(idx, 1)
        }

        if (island.peers.length === 0) {
          this.islands.delete(island.id)
        }

        island._geometryDirty = true

        this.pendingUpdates.set(peer.id, { action: 'leave', islandId: peer.islandId })
      }
    }
  }

  async flush(): Promise<IslandUpdates> {
    for (const [id, change] of this.pendingNewPeers) {
      this.peers.set(id, change)
      await this.createIsland([change])
    }
    this.pendingNewPeers.clear()

    const affectedIslands = new Set<string>()
    for (const island of this.islands.values()) {
      if (island._geometryDirty) {
        affectedIslands.add(island.id)
      }
    }

    for (const islandId of affectedIslands) {
      await this.checkSplitIsland(this.islands.get(islandId)!, affectedIslands)
    }

    // NOTE: check if islands can be merged
    const processedIslands: Record<string, boolean> = {}

    for (const islandId of affectedIslands) {
      if (!processedIslands[islandId] && this.islands.has(islandId)) {
        const island = this.islands.get(islandId)!
        const islandsIntersected: Island[] = []
        for (const [, otherIsland] of this.islands) {
          if (islandId !== otherIsland.id && this.intersectIslands(island, otherIsland, this.joinDistance)) {
            islandsIntersected.push(otherIsland)
            processedIslands[islandId] = true
          }
        }
        if (islandsIntersected.length > 0) {
          await this.mergeIslands(island, ...islandsIntersected)
        }
      }
    }

    const updates = new Map(this.pendingUpdates)
    this.pendingUpdates.clear()

    for (const [peerId, update] of updates) {
      if (update.action === 'changeTo') {
        const island = this.islands.get(update.islandId)!
        this.publisher.onChangeToIsland(peerId, island, update)
      } else if (update.action === 'leave') {
        this.publisher.onPeerLeft(peerId, update.islandId)
      }
    }
    return updates
  }

  private async checkSplitIsland(island: Island, affectedIslands: Set<string>) {
    const peerGroups: PeerData[][] = []

    for (const peer of island.peers) {
      const groupsIntersected = peerGroups.filter((it) => this.intersectPeerGroup(peer, it, this.leaveDistance))
      if (groupsIntersected.length === 0) {
        peerGroups.push([peer])
      } else {
        // We merge all the groups into one
        const [finalGroup, ...rest] = groupsIntersected
        finalGroup.push(peer)

        for (const group of rest) {
          // We remove each group
          peerGroups.splice(peerGroups.indexOf(group), 1)

          //We add the members of each group to the final group
          finalGroup.push(...group)
        }
      }
    }

    if (peerGroups.length > 1) {
      const biggestGroup = popMax(peerGroups, (group) => group.length)!
      island.peers = biggestGroup
      island._geometryDirty = true

      for (const group of peerGroups) {
        affectedIslands.add(await this.createIsland(group))
      }
    }
  }

  private async createIsland(group: PeerData[]): Promise<string> {
    const newIslandId = this.islandIdGenerator.generateId()

    const reservedSeatsPerTransport = new Map<number, number>()
    for (const island of this.islands.values()) {
      if (island.transportId === 0) {
        continue
      }

      const reserved = reservedSeatsPerTransport.get(island.transportId) || 0
      reservedSeatsPerTransport.set(island.transportId, reserved + (island.maxPeers - island.peers.length))
    }

    const p2pTransport = this.transports.get(0)!
    let transport = p2pTransport

    for (const [id, t] of this.transports) {
      if (id === p2pTransport.id) {
        continue
      }

      const reservedSeats = reservedSeatsPerTransport.get(transport.id) || 0
      if (t.availableSeats - reservedSeats >= t.maxIslandSize) {
        transport = t
      }
    }

    let connStrs: Record<string, string>
    const peerIds = group.map((p) => p.id)
    try {
      connStrs = await transport.getConnectionStrings(peerIds, newIslandId)
    } catch (err: any) {
      this.logger.warn(err)
      transport = p2pTransport

      // NOTE: this won't fail
      connStrs = await transport.getConnectionStrings(peerIds, newIslandId)
    }

    const island: Island = {
      id: newIslandId,
      transportId: transport.id,
      peers: group,
      maxPeers: transport.maxIslandSize,
      sequenceId: ++this.currentSequence,
      _geometryDirty: true,
      get center() {
        recalculateGeometryIfNeeded(this)
        return this._center!
      },
      get radius() {
        recalculateGeometryIfNeeded(this)
        return this._radius!
      }
    }

    this.islands.set(newIslandId, island)

    this.setPeersIsland(island, group, connStrs)

    return newIslandId
  }

  private async mergeIntoIfPossible(islandToMergeInto: Island, anIsland: Island) {
    const canMerge = islandToMergeInto.peers.length + anIsland.peers.length <= islandToMergeInto.maxPeers
    if (!canMerge) {
      return false
    }

    const transport = this.transports.get(islandToMergeInto.transportId)
    if (!transport) {
      return false
    }

    try {
      const connStrs = await transport.getConnectionStrings(
        anIsland.peers.map((p) => p.id),
        islandToMergeInto.id
      )

      islandToMergeInto.peers.push(...anIsland.peers)
      this.setPeersIsland(islandToMergeInto, anIsland.peers, connStrs)
      this.islands.delete(anIsland.id)
      islandToMergeInto._geometryDirty = true

      return true
    } catch (err: any) {
      this.logger.warn(err)
      return false
    }
  }

  private async mergeIslands(...islands: Island[]) {
    const sortedIslands = islands.sort((i1, i2) =>
      i1.peers.length === i2.peers.length
        ? Math.sign(i1.sequenceId - i2.sequenceId)
        : Math.sign(i2.peers.length - i1.peers.length)
    )

    const biggestIslands: Island[] = [sortedIslands.shift()!]

    let anIsland: Island | undefined

    while ((anIsland = sortedIslands.shift())) {
      let merged = false

      const preferedIslandId = this.getPreferedIslandFor(anIsland)

      // We only support prefered islands for islands bigger and/or older than the one we are currently processing.
      // It would be very unlikely that there is a valid use case for the other possibilities
      const preferedIsland = preferedIslandId ? biggestIslands.find((it) => it.id === preferedIslandId) : undefined

      if (preferedIsland) {
        merged = await this.mergeIntoIfPossible(preferedIsland, anIsland)
      }

      for (let i = 0; !merged && i < biggestIslands.length; i++) {
        merged = await this.mergeIntoIfPossible(biggestIslands[i], anIsland)
      }

      if (!merged) {
        biggestIslands.push(anIsland)
      }
    }
  }

  private setPeersIsland(island: Island, peers: PeerData[], connStrs: Record<string, string>) {
    for (const peer of peers) {
      const previousIslandId = peer.islandId
      peer.islandId = island.id
      this.pendingUpdates.set(peer.id, {
        action: 'changeTo',
        islandId: island.id,
        fromIslandId: previousIslandId,
        connStr: connStrs[peer.id]!
      })
    }
  }

  private getPreferedIslandFor(anIsland: Island) {
    const votes: Record<string, number> = {}
    let mostVoted: string | undefined

    for (const peer of anIsland.peers) {
      if (peer.preferedIslandId) {
        votes[peer.preferedIslandId] = peer.preferedIslandId in votes ? votes[peer.preferedIslandId] + 1 : 1

        if (!mostVoted || votes[mostVoted] < votes[peer.preferedIslandId]) {
          mostVoted = peer.preferedIslandId
        }
      }
    }

    return mostVoted
  }

  private intersectIslands(anIsland: Island, otherIsland: Island, intersectDistance: number) {
    const intersectIslandGeometry =
      squaredDistance(anIsland.center, otherIsland.center) <=
      squared(anIsland.radius + otherIsland.radius + intersectDistance)

    return (
      intersectIslandGeometry &&
      anIsland.peers.some((it) => this.intersectPeerGroup(it, otherIsland.peers, intersectDistance))
    )
  }

  private intersectPeerGroup(peer: PeerData, group: PeerData[], intersectDistance: number) {
    const intersectPeers = (aPeer: PeerData, otherPeer: PeerData) => {
      return squaredDistance(aPeer.position, otherPeer.position) <= squared(intersectDistance)
    }
    return group.some((it) => intersectPeers(peer, it))
  }

  async dispose() {
    this.disposed = true
  }
}
