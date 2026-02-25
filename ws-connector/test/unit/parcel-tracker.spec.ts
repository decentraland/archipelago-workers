import { createParcelTracker } from '../../src/adapters/parcel-tracker'

describe('parcel-tracker', () => {
  it('should track peer position and derive parcel', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 32, 48) // parcel 2,3
    const peers = tracker.getPeersOnParcels(['2,3'])
    expect(peers).toEqual(['peer1'])
  })

  it('should return empty array for empty parcels', () => {
    const tracker = createParcelTracker()
    expect(tracker.getPeersOnParcels(['0,0'])).toEqual([])
  })

  it('should handle position at origin', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 0, 0) // parcel 0,0
    expect(tracker.getPeersOnParcels(['0,0'])).toEqual(['peer1'])
  })

  it('should handle negative coordinates', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', -16, -32) // parcel -1,-2
    expect(tracker.getPeersOnParcels(['-1,-2'])).toEqual(['peer1'])
  })

  it('should handle fractional positions within same parcel', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 1, 15) // parcel 0,0
    tracker.updatePeerPosition('peer2', 8.5, 7.3) // parcel 0,0
    const peers = tracker.getPeersOnParcels(['0,0'])
    expect(peers).toHaveLength(2)
    expect(peers).toContain('peer1')
    expect(peers).toContain('peer2')
  })

  it('should update peer parcel when position changes', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 0, 0) // parcel 0,0
    tracker.updatePeerPosition('peer1', 32, 32) // parcel 2,2

    expect(tracker.getPeersOnParcels(['0,0'])).toEqual([])
    expect(tracker.getPeersOnParcels(['2,2'])).toEqual(['peer1'])
  })

  it('should not create duplicate entries when position stays in same parcel', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 1, 1) // parcel 0,0
    tracker.updatePeerPosition('peer1', 2, 3) // still parcel 0,0

    expect(tracker.getPeersOnParcels(['0,0'])).toEqual(['peer1'])
  })

  it('should remove peer', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 0, 0)
    tracker.updatePeerPosition('peer2', 0, 0)
    tracker.removePeer('peer1')

    expect(tracker.getPeersOnParcels(['0,0'])).toEqual(['peer2'])
  })

  it('should handle removing unknown peer gracefully', () => {
    const tracker = createParcelTracker()
    expect(() => tracker.removePeer('unknown')).not.toThrow()
  })

  it('should return union of peers across multiple parcels', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 0, 0) // parcel 0,0
    tracker.updatePeerPosition('peer2', 16, 0) // parcel 1,0
    tracker.updatePeerPosition('peer3', 32, 0) // parcel 2,0

    const peers = tracker.getPeersOnParcels(['0,0', '1,0'])
    expect(peers).toHaveLength(2)
    expect(peers).toContain('peer1')
    expect(peers).toContain('peer2')
    expect(peers).not.toContain('peer3')
  })

  it('should deduplicate peers when parcels overlap in query', () => {
    const tracker = createParcelTracker()
    tracker.updatePeerPosition('peer1', 0, 0)

    // Query the same parcel twice
    const peers = tracker.getPeersOnParcels(['0,0', '0,0'])
    expect(peers).toEqual(['peer1'])
  })
})
