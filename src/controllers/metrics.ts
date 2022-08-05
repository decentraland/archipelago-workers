import { AppComponents } from '../types'

export async function setupMetrics({
  config,
  logs,
  metrics,
  archipelago
}: Pick<AppComponents, 'metrics' | 'logs' | 'archipelago' | 'config'>) {
  const logger = logs.getLogger('Archipelago metrics')

  const archipelagoMetricsInterval = await config.requireNumber('ARCHIPELAGO_METRICS_INTERVAL')

  async function publishMetrics() {
    const archMetrics = await archipelago.calculateMetrics()

    metrics.observe('dcl_archipelago_peers_count', { transport: 'livekit' }, archMetrics.peers.transport.livekit)
    metrics.observe('dcl_archipelago_peers_count', { transport: 'ws' }, archMetrics.peers.transport.ws)
    metrics.observe('dcl_archipelago_peers_count', { transport: 'p2p' }, archMetrics.peers.transport.p2p)

    metrics.observe('dcl_archipelago_islands_count', { transport: 'livekit' }, archMetrics.islands.transport.livekit)
    metrics.observe('dcl_archipelago_islands_count', { transport: 'ws' }, archMetrics.islands.transport.ws)
    metrics.observe('dcl_archipelago_islands_count', { transport: 'p2p' }, archMetrics.islands.transport.p2p)
  }

  async function start() {
    setInterval(async () => {
      try {
        await publishMetrics()
      } catch (err: any) {
        logger.error(err)
      }
    }, archipelagoMetricsInterval)
  }

  return {
    publishMetrics,
    start
  }
}
