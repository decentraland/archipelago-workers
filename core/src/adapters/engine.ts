import {
  PeerData,
  Island,
  PeerPositionChange,
  Transport,
  BaseComponents,
  ChangeToIslandUpdate,
  LeaveIslandUpdate,
  IslandUpdates,
  Engine
} from '../types'

import { intersectPeerGroup, popMax } from '../logic/islands'
import { sequentialIdGenerator } from '../logic/idGenerator'
import { intersectIslands, islandGeometryCalculator } from '../logic/islands'

export type Options = {
  components: Pick<BaseComponents, 'logs' | 'metrics'>
  roomPrefix?: string
  joinDistance: number
  leaveDistance: number
  transport: Transport
}

function recalculateGeometryIfNeeded(island: Island) {
  if (
    island.peers.length > 0 &&
    (island._geometryDirty || island._radius === undefined || island._radius === null || !island._center)
  ) {
    const [center, radius] = islandGeometryCalculator(island.peers)
    island._center = center
    island._radius = radius
    island._geometryDirty = false
  }
}

export function createArchipelagoEngine({
  components: { logs, metrics },
  joinDistance,
  leaveDistance,
  transport,
  roomPrefix
}: Options): Engine {
  const logger = logs.getLogger('Archipelago')
  const peers = new Map<string, PeerData>()
  const islands = new Map<string, Island>()
  const pendingNewPeers = new Map<string, PeerData>()
  const pendingUpdates = new Map<string, ChangeToIslandUpdate | LeaveIslandUpdate>()
  const islandIdGenerator = sequentialIdGenerator(roomPrefix || 'I')
  let currentSequence = 0

  function onPeerPositionsUpdate(changes: PeerPositionChange[]): void {
    for (const change of changes) {
      const { id, position, preferedIslandId } = change
      if (!peers.has(id)) {
        pendingNewPeers.set(id, change)
      } else {
        const peer = peers.get(id)!
        peer.position = position

        // We can set the prefered island to undefined by explicitly providing the key but no value.
        // If we don't provide the key, we leave it as it is
        if ('preferedIslandId' in change) {
          peer.preferedIslandId = preferedIslandId
        }

        if (peer.islandId) {
          const island = islands.get(peer.islandId)
          if (island) {
            island._geometryDirty = true
          }
        }
      }
    }
  }

  function getIslands(): Island[] {
    return Array.from(islands.values())
  }

  function getIsland(id: string): Island | undefined {
    return islands.get(id)
  }

  function getPeerData(id: string): PeerData | undefined {
    return peers.get(id)
  }

  function getPeerCount(): number {
    return peers.size
  }

  function onPeerDisconnected(id: string): void {
    const peer = peers.get(id)
    pendingNewPeers.delete(id)

    if (peer) {
      peers.delete(id)
      if (peer.islandId) {
        const island = islands.get(peer.islandId)

        if (island) {
          const idx = island.peers.findIndex((it) => it.id === id)
          if (idx >= 0) {
            island.peers.splice(idx, 1)
          }

          island._geometryDirty = true

          if (island.peers.length === 0) {
            islands.delete(island.id)
          }
        }

        pendingUpdates.set(peer.id, { action: 'leave', islandId: peer.islandId })
      }
    }
  }

  async function flush(): Promise<IslandUpdates> {
    for (const [id, change] of pendingNewPeers) {
      peers.set(id, change)
      try {
        await createIsland([change])
      } catch (err: any) {
        // Remove from peers so the peer is not orphaned without an island.
        // The next heartbeat will re-add it to pendingNewPeers for retry.
        peers.delete(id)
        logger.error(err)
      }
    }
    pendingNewPeers.clear()

    const affectedIslands = new Set<string>()
    for (const island of islands.values()) {
      if (island._geometryDirty) {
        affectedIslands.add(island.id)
      }
    }

    for (const islandId of affectedIslands) {
      const island = islands.get(islandId)
      if (island) {
        await checkSplitIsland(island, affectedIslands)
      }
    }

    // NOTE: check if islands can be merged
    const processedIslands: Record<string, boolean> = {}

    for (const islandId of affectedIslands) {
      if (!processedIslands[islandId] && islands.has(islandId)) {
        const island = islands.get(islandId)!
        const islandsIntersected: Island[] = []
        for (const [, otherIsland] of islands) {
          if (islandId !== otherIsland.id && intersectIslands(island, otherIsland, joinDistance)) {
            islandsIntersected.push(otherIsland)
            processedIslands[islandId] = true
          }
        }
        if (islandsIntersected.length > 0) {
          await mergeIslands(island, ...islandsIntersected)
        }
      }
    }

    metrics.observe('dcl_archipelago_islands_count', {}, islands.size)
    metrics.observe('dcl_archipelago_peers_count', {}, peers.size)

    const updates = new Map(pendingUpdates)
    pendingUpdates.clear()
    return updates
  }

  async function checkSplitIsland(island: Island, affectedIslands: Set<string>) {
    const peerGroups: PeerData[][] = []

    for (const peer of island.peers) {
      const groupsIntersected = peerGroups.filter((it) => intersectPeerGroup(peer, it, leaveDistance))
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
        try {
          affectedIslands.add(await createIsland(group))
        } catch (err: any) {
          // createIsland failed before setPeersIsland, so these peers were never
          // assigned to a new island. Put them back in the original island to
          // avoid orphaning them.
          island.peers.push(...group)
          logger.error(err)
        }
      }
    }
  }

  async function createIsland(group: PeerData[]): Promise<string> {
    const newIslandId = islandIdGenerator.generateId()
    const peerIds = group.map((p) => p.id)
    const connStrs = await transport.getConnectionStrings(peerIds, newIslandId)

    // After the await, filter out peers that disconnected during the transport call.
    // A NATS disconnect callback can fire during the await and remove peers from the
    // peers Map. If we include them, they become ghost peers in the island.
    const activePeers = group.filter((p) => peers.has(p.id))
    if (activePeers.length === 0) {
      return newIslandId
    }

    const island: Island = {
      id: newIslandId,
      peers: activePeers,
      maxPeers: transport.maxIslandSize,
      sequenceId: ++currentSequence,
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

    islands.set(newIslandId, island)

    setPeersIsland(island, activePeers, connStrs)

    return newIslandId
  }

  async function mergeIntoIfPossible(islandToMergeInto: Island, anIsland: Island) {
    const canMerge = islandToMergeInto.peers.length + anIsland.peers.length <= islandToMergeInto.maxPeers
    if (!canMerge) {
      return false
    }

    try {
      const connStrs = await transport.getConnectionStrings(
        anIsland.peers.map((p) => p.id),
        islandToMergeInto.id
      )

      // After the await, re-validate that both islands still exist and the merge
      // is still valid. A NATS disconnect callback can fire during the await and
      // delete islands or change peer counts.
      if (!islands.has(islandToMergeInto.id) || !islands.has(anIsland.id)) {
        return false
      }
      if (islandToMergeInto.peers.length + anIsland.peers.length > islandToMergeInto.maxPeers) {
        return false
      }

      // Filter out peers that disconnected during the await
      const activePeers = anIsland.peers.filter((p) => peers.has(p.id))
      if (activePeers.length === 0) {
        islands.delete(anIsland.id)
        return true
      }

      islandToMergeInto.peers.push(...activePeers)
      setPeersIsland(islandToMergeInto, activePeers, connStrs)
      islands.delete(anIsland.id)
      islandToMergeInto._geometryDirty = true

      return true
    } catch (err: any) {
      logger.warn(err)
      return false
    }
  }

  async function mergeIslands(...islandsToMerge: Island[]) {
    const sortedIslands = islandsToMerge.sort((i1, i2) =>
      i1.peers.length === i2.peers.length
        ? Math.sign(i1.sequenceId - i2.sequenceId)
        : Math.sign(i2.peers.length - i1.peers.length)
    )

    const biggestIslands: Island[] = [sortedIslands.shift()!]

    let anIsland: Island | undefined

    while ((anIsland = sortedIslands.shift())) {
      // Skip islands that were deleted by a concurrent disconnect during a previous await
      if (!islands.has(anIsland.id)) {
        continue
      }

      let merged = false

      const preferedIslandId = getPreferedIslandFor(anIsland)

      // We only support prefered islands for islands bigger and/or older than the one we are currently processing.
      // It would be very unlikely that there is a valid use case for the other possibilities
      const preferedIsland = preferedIslandId ? biggestIslands.find((it) => it.id === preferedIslandId) : undefined

      if (preferedIsland) {
        merged = await mergeIntoIfPossible(preferedIsland, anIsland)
      }

      for (let i = 0; !merged && i < biggestIslands.length; i++) {
        if (biggestIslands[i] === preferedIsland) continue
        merged = await mergeIntoIfPossible(biggestIslands[i], anIsland)
      }

      if (!merged) {
        biggestIslands.push(anIsland)
      }
    }
  }

  function setPeersIsland(island: Island, peers: PeerData[], connStrs: Record<string, string>) {
    for (const peer of peers) {
      const previousIslandId = peer.islandId
      peer.islandId = island.id
      pendingUpdates.set(peer.id, {
        action: 'changeTo',
        islandId: island.id,
        fromIslandId: previousIslandId,
        connStr: connStrs[peer.id]!
      })
    }
  }

  function getPreferedIslandFor(anIsland: Island) {
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

  return {
    flush,
    onPeerPositionsUpdate,
    getPeerCount,
    onPeerDisconnected,
    getIslands,
    getIsland,
    getPeerData
  }
}
