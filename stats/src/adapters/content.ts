import { Entity } from '@dcl/schemas'
import { createContentClient } from 'dcl-catalyst-client'
import { IBaseComponent, IFetchComponent as IWkcFetchComponent } from '@well-known-components/interfaces'
import { BaseComponents } from '../types'

export type IContentComponent = IBaseComponent & {
  fetchScenes: (tiles: string[]) => Promise<Entity[]>
  calculateThumbnail: (scene: Entity) => string | undefined
}

export async function createContentComponent(
  components: Pick<BaseComponents, 'config' | 'fetch'>
): Promise<IContentComponent> {
  const { config, fetch } = components
  const url = (await config.getString('CONTENT_URL')) || 'https://peer.decentraland.org/content/'
  // dcl-catalyst-client still types its fetcher against node-fetch's IFetchComponent; the native fetch
  // (global Request/Response) is runtime-compatible, so cast it here.
  const contentClient = createContentClient({ url, fetcher: fetch as unknown as IWkcFetchComponent })

  function fetchScenes(tiles: string[]): Promise<Entity[]> {
    if (tiles.length === 0) {
      return Promise.resolve([])
    }
    return contentClient.fetchEntitiesByPointers(tiles)
  }

  function calculateThumbnail(scene: Entity): string | undefined {
    let thumbnail: string | undefined = scene.metadata?.display?.navmapThumbnail
    if (thumbnail && !thumbnail.startsWith('http')) {
      // We are assuming that the thumbnail is an uploaded file. We will try to find the matching hash

      const thumbnailHash = scene.content?.find(({ file }) => file === thumbnail)?.hash
      if (thumbnailHash) {
        thumbnail = `${url}/contents/${thumbnailHash}`
      } else {
        // If we couldn't find a file with the correct path, then we ignore whatever was set on the thumbnail property
        thumbnail = undefined
      }
    }
    return thumbnail
  }

  return {
    fetchScenes,
    calculateThumbnail
  }
}
