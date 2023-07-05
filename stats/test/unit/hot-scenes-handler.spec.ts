import { Entity } from '@dcl/schemas'
import { HotSceneInfo, hotScenesHandler } from '../../src/controllers/handlers/hot-scenes-handler'
import { createStatsComponent } from '../../src/adapters/stats'

describe('hot-scenes-handler-unit', () => {
  it('ok', async () => {
    const scenes = {
      '10,10': {
        id: 1,
        metadata: {
          contact: {
            name: 'creator'
          },
          source: {
            projectId: 'project-id'
          },
          scene: {
            base: '10,10',
            parcels: ['10,10', '10,11']
          },
          display: {
            title: 'test',
            description: 'a test'
          }
        }
      }
    }

    const stats = createStatsComponent()

    for (let i = 0; i < 10; i++) {
      const id = `${i}`
      const data = {
        time: Date.now(),
        address: id,
        x: 10 * 16,
        y: 0,
        z: 10 * 16
      }
      stats.onPeerUpdated(id, data)
    }
    for (let i = 0; i < 12; i++) {
      const id = `${10 + i}`
      const data = {
        time: Date.now(),
        address: id,
        x: 10 * 16,
        y: 0,
        z: 11 * 16
      }
      stats.onPeerUpdated(id, data)
    }
    const content = {
      fetchScenes: async (tiles: string[]) => {
        const result: Entity[] = []
        for (const tile of tiles) {
          if (scenes[tile]) {
            result.push(scenes[tile])
          }
        }
        return result
      },
      calculateThumbnail: (_: Entity) => 'thumb.jpg'
    }

    const url = new URL('https://aggregator.com/hot-scenes')
    const { body } = await hotScenesHandler({ url, components: { stats, content } })

    const result: HotSceneInfo[] = body

    expect(result).toHaveLength(1)
    expect(result[0].id).toEqual(1)
    expect(result[0].name).toEqual('test')
    expect(result[0].baseCoords).toEqual([10, 10])
    expect(result[0].usersTotalCount).toEqual(22)
    expect(result[0].parcels).toEqual([
      [10, 10],
      [10, 11]
    ])
    expect(result[0].thumbnail).toEqual('thumb.jpg')
    expect(result[0].projectId).toEqual('project-id')
    expect(result[0].creator).toEqual('creator')
    expect(result[0].description).toEqual('a test')
  })
})
