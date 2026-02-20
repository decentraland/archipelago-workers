import { createIslandRegistry } from '../../src/adapters/island-registry'

describe('island-registry', () => {
  it('should set and get peer island', () => {
    const registry = createIslandRegistry()
    registry.setPeerIsland('peer1', 'island1')
    expect(registry.getPeerIsland('peer1')).toBe('island1')
  })

  it('should return undefined for unknown peer', () => {
    const registry = createIslandRegistry()
    expect(registry.getPeerIsland('unknown')).toBeUndefined()
  })

  it('should return peers on island', () => {
    const registry = createIslandRegistry()
    registry.setPeerIsland('peer1', 'island1')
    registry.setPeerIsland('peer2', 'island1')
    registry.setPeerIsland('peer3', 'island2')

    const peers = registry.getPeersOnIsland('island1')
    expect(peers).toHaveLength(2)
    expect(peers).toContain('peer1')
    expect(peers).toContain('peer2')
  })

  it('should return empty array for unknown island', () => {
    const registry = createIslandRegistry()
    expect(registry.getPeersOnIsland('unknown')).toEqual([])
  })

  it('should move peer between islands', () => {
    const registry = createIslandRegistry()
    registry.setPeerIsland('peer1', 'island1')
    registry.setPeerIsland('peer1', 'island2')

    expect(registry.getPeerIsland('peer1')).toBe('island2')
    expect(registry.getPeersOnIsland('island1')).toEqual([])
    expect(registry.getPeersOnIsland('island2')).toContain('peer1')
  })

  it('should remove peer', () => {
    const registry = createIslandRegistry()
    registry.setPeerIsland('peer1', 'island1')
    registry.setPeerIsland('peer2', 'island1')
    registry.removePeer('peer1')

    expect(registry.getPeerIsland('peer1')).toBeUndefined()
    expect(registry.getPeersOnIsland('island1')).toEqual(['peer2'])
  })

  it('should clean up empty island when last peer removed', () => {
    const registry = createIslandRegistry()
    registry.setPeerIsland('peer1', 'island1')
    registry.removePeer('peer1')

    expect(registry.getPeersOnIsland('island1')).toEqual([])
  })

  it('should handle removing unknown peer gracefully', () => {
    const registry = createIslandRegistry()
    expect(() => registry.removePeer('unknown')).not.toThrow()
  })

  it('should handle setting peer to same island (no-op for island membership)', () => {
    const registry = createIslandRegistry()
    registry.setPeerIsland('peer1', 'island1')
    registry.setPeerIsland('peer1', 'island1')

    expect(registry.getPeersOnIsland('island1')).toEqual(['peer1'])
  })
})
