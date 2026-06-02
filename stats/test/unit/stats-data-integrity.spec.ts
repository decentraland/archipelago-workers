import { createStatsComponent, IStatsComponent } from '../../src/adapters/stats'
import { toParcel } from '../../src/logic/utils'
import { PeerData } from '../../src/types'

describe('stats data integrity', () => {
  let stats: IStatsComponent

  beforeEach(() => {
    stats = createStatsComponent()
  })

  describe('when a peer is updated with valid data', () => {
    let peer: PeerData

    beforeEach(() => {
      peer = { address: '0xabc', time: Date.now(), x: 100, y: 50, z: 200 }
      stats.onPeerUpdated('0xabc', peer)
    })

    it('should store the peer data correctly', () => {
      const stored = stats.getPeers().get('0xabc')
      expect(stored).toEqual(peer)
    })
  })

  describe('when a peer is updated with NaN position values', () => {
    let peer: PeerData

    beforeEach(() => {
      peer = { address: '0xnan', time: Date.now(), x: NaN, y: NaN, z: NaN }
      stats.onPeerUpdated('0xnan', peer)
    })

    it('should store the peer with NaN values', () => {
      const stored = stats.getPeers().get('0xnan')
      expect(stored).toBeDefined()
      expect(stored!.x).toBeNaN()
      expect(stored!.z).toBeNaN()
    })
  })

  describe('when a peer is disconnected', () => {
    beforeEach(() => {
      stats.onPeerUpdated('0xabc', { address: '0xabc', time: Date.now(), x: 0, y: 0, z: 0 })
      stats.onPeerDisconnected('0xabc')
    })

    it('should remove the peer from the map', () => {
      expect(stats.getPeers().has('0xabc')).toBe(false)
    })
  })

  describe('when disconnecting a peer that does not exist', () => {
    it('should not throw', () => {
      expect(() => stats.onPeerDisconnected('nonexistent')).not.toThrow()
    })
  })

  describe('when islands data is received', () => {
    beforeEach(() => {
      stats.onIslandsDataReceived([
        { id: 'I1', peers: ['0xabc'], maxPeers: 100, center: [10, 0, 20], radius: 5 }
      ])
    })

    it('should replace the previous islands data', () => {
      expect(stats.getIslands()).toHaveLength(1)
      expect(stats.getIslands()[0].id).toBe('I1')

      stats.onIslandsDataReceived([])
      expect(stats.getIslands()).toHaveLength(0)
    })
  })
})

describe('toParcel', () => {
  describe('when called with valid coordinates', () => {
    it('should convert world coordinates to parcel coordinates', () => {
      expect(toParcel(0, 0)).toEqual([0, 0])
      expect(toParcel(16, 16)).toEqual([1, 1])
      expect(toParcel(15, 15)).toEqual([0, 0])
      expect(toParcel(-1, -1)).toEqual([-1, -1])
      expect(toParcel(-16, -16)).toEqual([-1, -1])
      expect(toParcel(-17, -17)).toEqual([-2, -2])
    })
  })

  describe('when called with NaN coordinates', () => {
    it('should return NaN parcels', () => {
      const [x, y] = toParcel(NaN, NaN)
      expect(x).toBeNaN()
      expect(y).toBeNaN()
    })
  })
})
