import { AppComponents, ServiceDiscoveryMessage } from '../types'
import { JSONCodec } from '@well-known-components/nats-component'

const DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL = 10000

export async function setupServiceDiscovery({ nats, logs, config }: Pick<AppComponents, 'nats' | 'logs' | 'config'>) {
  const logger = logs.getLogger('Status discovery')

  const jsonCodec = JSONCodec()
  const freq =
    (await config.getNumber('ARCHIPELAGO_STATUS_UPDATE_INTERVAL')) ?? DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL
  const commitHash = await config.getString('COMMIT_HASH')

  function publishServiceDiscovery() {
    const status = {
      currentTime: Date.now(),
      commitHash
    }
    const serviceDiscoveryMessage: ServiceDiscoveryMessage = {
      serverName: 'archipelago',
      status
    }
    const encodedMsg = jsonCodec.encode(serviceDiscoveryMessage)
    nats.publish('service.discovery', encodedMsg)
  }

  async function start() {
    setInterval(() => {
      try {
        publishServiceDiscovery()
      } catch (err: any) {
        logger.error(err)
      }
    }, freq)
  }

  return {
    start,
    publishServiceDiscovery
  }
}
