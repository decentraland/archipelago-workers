import { HandlerContextWithPath } from '../../types'

export async function statusHandler(
  context: Pick<HandlerContextWithPath<'config' | 'peersRegistry', '/status'>, 'url' | 'components'>
) {
  const {
    components: { config, peersRegistry }
  } = context

  const [commitHash, version] = await Promise.all([
    config.getString('COMMIT_HASH'),
    config.getString('CURRENT_VERSION')
  ])

  return {
    body: {
      version: version ?? '',
      currentTime: Date.now(),
      commitHash: commitHash ?? '',
      userCount: peersRegistry.getPeerCount()
    }
  }
}
