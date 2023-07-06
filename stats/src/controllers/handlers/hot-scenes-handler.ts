import { HandlerContextWithPath, ParcelCoord } from '../../types'
import { toParcel } from '../../logic/utils'

// The maximum amount of hot scenes returned
const HOT_SCENES_LIMIT = 100

export type HotSceneInfo = {
  id: string
  name: string
  baseCoords: ParcelCoord
  usersTotalCount: number
  parcels: ParcelCoord[]
  thumbnail?: string
  projectId?: string
  creator?: string
  description?: string
}

function getCoords(coordsAsString: string): ParcelCoord {
  return coordsAsString.split(',').map((part) => parseInt(part, 10)) as ParcelCoord
}

// handlers arguments only type what they need, to make unit testing easier
export async function hotScenesHandler(
  context: Pick<HandlerContextWithPath<'stats' | 'content', '/hot-scenes'>, 'url' | 'components'>
) {
  const {
    components: { stats, content }
  } = context

  const peers = stats.getPeers()

  const countPerTile = new Map<string, number>()
  for (const { x, z } of peers.values()) {
    const [parcelX, parcelY] = toParcel(x, z)

    const tile = `${parcelX},${parcelY}`
    countPerTile.set(tile, (countPerTile.get(tile) || 0) + 1)
  }

  const scenes = await content.fetchScenes(Array.from(countPerTile.keys()))

  const hotScenes: HotSceneInfo[] = scenes.map((scene) => {
    const result: HotSceneInfo = {
      id: scene.id,
      name: scene.metadata?.display?.title,
      baseCoords: getCoords(scene.metadata?.scene.base),
      usersTotalCount: 0,
      parcels: scene.metadata?.scene.parcels.map(getCoords),
      thumbnail: content.calculateThumbnail(scene),
      creator: scene.metadata?.contact?.name,
      projectId: scene.metadata?.source?.projectId,
      description: scene.metadata?.display?.description
    }

    for (const sceneParcel of scene.metadata?.scene.parcels) {
      if (countPerTile.has(sceneParcel)) {
        const usersInParcel = countPerTile.get(sceneParcel) || 0
        result.usersTotalCount += usersInParcel

        const userParcels: ParcelCoord[] = []
        const coord = getCoords(sceneParcel)
        for (let i = 0; i < usersInParcel; i++) {
          userParcels.push(coord)
        }
      }
    }

    return result
  })

  const value = hotScenes.sort((scene1, scene2) => scene2.usersTotalCount - scene1.usersTotalCount)

  return {
    body: value.slice(0, HOT_SCENES_LIMIT)
  }
}
