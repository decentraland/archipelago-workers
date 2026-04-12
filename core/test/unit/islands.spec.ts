import { intersectIslands, intersectPeerGroup, islandGeometryCalculator, popMax } from '../../src/logic/islands'
import { Island, PeerData, Position3D } from '../../src/types'

function createPeer(id: string, position: Position3D): PeerData {
  return { id, position }
}

function createIsland(
  id: string,
  peers: PeerData[],
  overrides: Partial<Island> = {}
): Island {
  const [center, radius] = islandGeometryCalculator(peers)
  return {
    id,
    peers,
    maxPeers: 100,
    sequenceId: 1,
    _geometryDirty: false,
    _center: center,
    _radius: radius,
    get center() {
      return this._center!
    },
    get radius() {
      return this._radius!
    },
    ...overrides
  }
}

describe('islandGeometryCalculator', () => {
  describe('when called with no peers', () => {
    let result: [Position3D, number]

    beforeEach(() => {
      result = islandGeometryCalculator([])
    })

    it('should return center at origin', () => {
      expect(result[0]).toEqual([0, 0, 0])
    })

    it('should return radius of zero', () => {
      expect(result[1]).toBe(0)
    })
  })

  describe('when called with a single peer', () => {
    let result: [Position3D, number]

    beforeEach(() => {
      const peers = [createPeer('1', [50, 10, 30])]
      result = islandGeometryCalculator(peers)
    })

    it('should return the peer position as center', () => {
      expect(result[0]).toEqual([50, 0, 30])
    })

    it('should return radius of zero', () => {
      expect(result[1]).toBe(0)
    })
  })

  describe('when called with two peers', () => {
    let result: [Position3D, number]

    beforeEach(() => {
      const peers = [createPeer('1', [0, 0, 0]), createPeer('2', [40, 0, 40])]
      result = islandGeometryCalculator(peers)
    })

    it('should return the midpoint as center', () => {
      expect(result[0]).toEqual([20, 0, 20])
    })

    it('should return the distance from center to the farthest peer as radius', () => {
      expect(result[1]).toBeCloseTo(Math.sqrt(800), 5)
    })
  })

  describe('when called with peers at different Y positions', () => {
    let result: [Position3D, number]

    beforeEach(() => {
      const peers = [createPeer('1', [0, 100, 0]), createPeer('2', [0, 200, 0])]
      result = islandGeometryCalculator(peers)
    })

    it('should ignore Y axis for center calculation', () => {
      expect(result[0]).toEqual([0, 0, 0])
    })

    it('should return radius of zero since X and Z are identical', () => {
      expect(result[1]).toBe(0)
    })
  })

  describe('when all peers are at the same position', () => {
    let result: [Position3D, number]

    beforeEach(() => {
      const peers = [
        createPeer('1', [10, 0, 10]),
        createPeer('2', [10, 0, 10]),
        createPeer('3', [10, 0, 10])
      ]
      result = islandGeometryCalculator(peers)
    })

    it('should return the shared position as center', () => {
      expect(result[0]).toEqual([10, 0, 10])
    })

    it('should return radius of zero', () => {
      expect(result[1]).toBe(0)
    })
  })

  describe('when peers form a line along X axis', () => {
    let result: [Position3D, number]

    beforeEach(() => {
      const peers = [
        createPeer('1', [0, 0, 0]),
        createPeer('2', [10, 0, 0]),
        createPeer('3', [6, 0, 0]),
        createPeer('4', [40, 0, 0])
      ]
      result = islandGeometryCalculator(peers)
    })

    it('should calculate center as the average X position', () => {
      expect(result[0][0]).toBe(14)
      expect(result[0][2]).toBe(0)
    })

    it('should set radius to encompass the farthest peer', () => {
      expect(result[1]).toBeCloseTo(26, 5)
    })
  })
})

describe('intersectPeerGroup', () => {
  describe('when the group is empty', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      result = intersectPeerGroup(peer, [], 64)
    })

    it('should return false', () => {
      expect(result).toBe(false)
    })
  })

  describe('when the peer is within intersect distance of a group member', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      const group = [createPeer('2', [30, 0, 30])]
      result = intersectPeerGroup(peer, group, 64)
    })

    it('should return true', () => {
      expect(result).toBe(true)
    })
  })

  describe('when the peer is outside the intersect distance of all group members', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      const group = [createPeer('2', [100, 0, 100])]
      result = intersectPeerGroup(peer, group, 64)
    })

    it('should return false', () => {
      expect(result).toBe(false)
    })
  })

  describe('when the peer is exactly at the intersect distance boundary', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      const group = [createPeer('2', [64, 0, 0])]
      result = intersectPeerGroup(peer, group, 64)
    })

    it('should return true since distance equals the threshold', () => {
      expect(result).toBe(true)
    })
  })

  describe('when the peer is just past the intersect distance boundary', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      const group = [createPeer('2', [64.01, 0, 0])]
      result = intersectPeerGroup(peer, group, 64)
    })

    it('should return false', () => {
      expect(result).toBe(false)
    })
  })

  describe('when the peer differs only in Y axis', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      const group = [createPeer('2', [0, 1000, 0])]
      result = intersectPeerGroup(peer, group, 64)
    })

    it('should return true since Y axis is ignored in distance calculation', () => {
      expect(result).toBe(true)
    })
  })

  describe('when only one member of a multi-peer group is within range', () => {
    let result: boolean

    beforeEach(() => {
      const peer = createPeer('1', [0, 0, 0])
      const group = [createPeer('2', [200, 0, 200]), createPeer('3', [10, 0, 10])]
      result = intersectPeerGroup(peer, group, 64)
    })

    it('should return true', () => {
      expect(result).toBe(true)
    })
  })
})

describe('intersectIslands', () => {
  describe('when islands are far apart', () => {
    let result: boolean

    beforeEach(() => {
      const island1 = createIsland('I1', [createPeer('1', [0, 0, 0])])
      const island2 = createIsland('I2', [createPeer('2', [200, 0, 200])])
      result = intersectIslands(island1, island2, 64)
    })

    it('should return false', () => {
      expect(result).toBe(false)
    })
  })

  describe('when islands are close together', () => {
    let result: boolean

    beforeEach(() => {
      const island1 = createIsland('I1', [createPeer('1', [0, 0, 0])])
      const island2 = createIsland('I2', [createPeer('2', [50, 0, 0])])
      result = intersectIslands(island1, island2, 64)
    })

    it('should return true', () => {
      expect(result).toBe(true)
    })
  })

  describe('when island geometries overlap but no peer pair is within distance', () => {
    let result: boolean

    beforeEach(() => {
      // Island 1: peers at [0,0,0] and [60,0,0], center=[30,0,0], radius=30
      // Island 2: peers at [100,0,0] and [160,0,0], center=[130,0,0], radius=30
      // Geometry overlap check: distance between centers=100, radii+joinDistance=30+30+64=124 -> overlaps
      // But closest peers are [60,0,0] and [100,0,0], distance=40 < 64 -> peers overlap too
      // Let me create a case where geometry overlaps but peers don't:
      // Island 1: peers at [0,0,0] and [0,0,60], center=[0,0,30], radius=30
      // Island 2: peers at [90,0,0] and [90,0,60], center=[90,0,30], radius=30
      // Geometry: center dist=90, radii+join=30+30+64=124 -> overlaps
      // Peer distances: [0,0,0]->[90,0,0]=90, [0,0,0]->[90,0,60]=sqrt(90^2+60^2)=108, etc. All > 64
      const island1 = createIsland('I1', [createPeer('1', [0, 0, 0]), createPeer('2', [0, 0, 60])])
      const island2 = createIsland('I2', [createPeer('3', [90, 0, 0]), createPeer('4', [90, 0, 60])])
      result = intersectIslands(island1, island2, 64)
    })

    it('should return false because peer-level check fails', () => {
      expect(result).toBe(false)
    })
  })

  describe('when single-peer islands are exactly at the join distance', () => {
    let result: boolean

    beforeEach(() => {
      const island1 = createIsland('I1', [createPeer('1', [0, 0, 0])])
      const island2 = createIsland('I2', [createPeer('2', [64, 0, 0])])
      result = intersectIslands(island1, island2, 64)
    })

    it('should return true', () => {
      expect(result).toBe(true)
    })
  })
})

describe('popMax', () => {
  describe('when the array is empty', () => {
    let result: number | undefined

    beforeEach(() => {
      result = popMax([], (x) => x)
    })

    it('should return undefined', () => {
      expect(result).toBeUndefined()
    })
  })

  describe('when the array has a single element', () => {
    let array: number[]
    let result: number | undefined

    beforeEach(() => {
      array = [42]
      result = popMax(array, (x) => x)
    })

    it('should return that element', () => {
      expect(result).toBe(42)
    })

    it('should leave the array empty', () => {
      expect(array).toEqual([])
    })
  })

  describe('when the array has multiple elements', () => {
    let array: number[]
    let result: number | undefined

    beforeEach(() => {
      array = [3, 7, 1, 9, 4]
      result = popMax(array, (x) => x)
    })

    it('should return the max element', () => {
      expect(result).toBe(9)
    })

    it('should remove the max element from the array', () => {
      expect(array).toEqual([3, 7, 1, 4])
    })

    it('should preserve the order of remaining elements', () => {
      expect(array[0]).toBe(3)
      expect(array[1]).toBe(7)
      expect(array[2]).toBe(1)
      expect(array[3]).toBe(4)
    })
  })

  describe('when using a custom criteria function', () => {
    let array: { name: string; size: number }[]
    let result: { name: string; size: number } | undefined

    beforeEach(() => {
      array = [
        { name: 'small', size: 1 },
        { name: 'large', size: 10 },
        { name: 'medium', size: 5 }
      ]
      result = popMax(array, (x) => x.size)
    })

    it('should return the element with the highest criteria value', () => {
      expect(result).toEqual({ name: 'large', size: 10 })
    })

    it('should remove the max element from the array', () => {
      expect(array).toHaveLength(2)
      expect(array.find((x) => x.name === 'large')).toBeUndefined()
    })
  })
})
