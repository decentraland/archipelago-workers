import { PeerData, Position3D, Island } from '../types'

const X_AXIS = 0
const Z_AXIS = 2

export function intersectIslands(anIsland: Island, otherIsland: Island, intersectDistance: number) {
  const intersectIslandGeometry =
    squaredDistance(anIsland.center, otherIsland.center) <=
    squared(anIsland.radius + otherIsland.radius + intersectDistance)

  return (
    intersectIslandGeometry && anIsland.peers.some((it) => intersectPeerGroup(it, otherIsland.peers, intersectDistance))
  )
}

export function intersectPeerGroup(peer: PeerData, group: PeerData[], intersectDistance: number) {
  const intersectPeers = (aPeer: PeerData, otherPeer: PeerData) => {
    return squaredDistance(aPeer.position, otherPeer.position) <= squared(intersectDistance)
  }
  return group.some((it) => intersectPeers(peer, it))
}

export function islandGeometryCalculator(peers: PeerData[]): [Position3D, number] {
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

/**
 * Removes the "max" element by criteria and returns it. Mutates the array.
 */
export function popMax<T>(array: T[], criteria: (t: T) => number) {
  const i = findMaxIndex(array, criteria)
  if (i === undefined) {
    return undefined
  }

  const [max] = array.splice(i, 1)
  return max
}

/**
 * Finds the index of the element that is first according to the provided ordering
 * @param array the array in which to look up the index
 * @param ordering a function returning -1 if the element on the left goes first, 0 if they are the equivalent, and 1 if right goes first
 * @returns
 */
function findIndexOfFirstByOrder<T>(array: T[], ordering: (t1: T, t2: T) => number) {
  if (array.length === 0) return undefined

  let biggestIndex = 0

  for (let i = 1; i < array.length; i++) {
    if (ordering(array[i], array[biggestIndex]) < 0) {
      biggestIndex = i
    }
  }

  return biggestIndex
}

function findMaxIndex<T>(array: T[], criteria: (t: T) => number) {
  return findIndexOfFirstByOrder(array, (t1, t2) => Math.sign(criteria(t2) - criteria(t1)))
}

function findMax<T>(array: T[], criteria: (t: T) => number) {
  const index = findMaxIndex(array, criteria)
  return typeof index !== 'undefined' ? array[index] : undefined
}

function squaredDistance(p1: Position3D, p2: Position3D) {
  // By default, we use XZ plane squared distance. We ignore "height"
  const xDiff = p2[X_AXIS] - p1[X_AXIS]
  const zDiff = p2[Z_AXIS] - p1[Z_AXIS]

  return xDiff * xDiff + zDiff * zDiff
}

function squared(n: number) {
  return n * n
}
