import { IMetricsComponent } from '@well-known-components/interfaces'
import { getDefaultHttpMetrics, validateMetricsDeclaration } from '@well-known-components/metrics'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  test_ping_counter: {
    help: 'Count calls to ping',
    type: IMetricsComponent.CounterType,
    labelNames: ['pathname']
  },
  dcl_archipelago_peers_count: {
    help: 'Number of peers in islands',
    type: IMetricsComponent.GaugeType,
    labelNames: ['transport'] // transport=(livekit|ws|p2p)
  },
  dcl_archipelago_islands_count: {
    help: 'Number of live islands',
    type: IMetricsComponent.GaugeType,
    labelNames: ['transport'] // transport=(livekit|ws|p2p)
  },
  dcl_archipelago_change_island_count: {
    help: 'Count change island messages',
    type: IMetricsComponent.CounterType
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
