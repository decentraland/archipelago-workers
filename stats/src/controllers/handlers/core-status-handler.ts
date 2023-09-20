import { HandlerContextWithPath } from '../../types'

type Result = {
  body: {
    healthy: boolean
    userCount: number
  }
}

export async function coreStatusHandler(
  context: Pick<HandlerContextWithPath<'coreStatus', '/status'>, 'url' | 'components'>
): Promise<Result> {
  const {
    components: { coreStatus }
  } = context
  return {
    body: {
      healthy: coreStatus.isHealthy(),
      userCount: coreStatus.getUserCount()
    }
  }
}
