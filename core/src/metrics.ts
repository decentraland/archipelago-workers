import { IMetricsComponent } from '@well-known-components/interfaces'
import { getDefaultHttpMetrics, validateMetricsDeclaration } from '@well-known-components/metrics'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  dcl_archipelago_peers_count: {
    help: 'Number of peers in islands',
    type: IMetricsComponent.GaugeType
  },
  dcl_archipelago_islands_count: {
    help: 'Number of live islands',
    type: IMetricsComponent.GaugeType
  },
  dcl_archipelago_change_island_count: {
    help: 'Count change island messages',
    type: IMetricsComponent.CounterType
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
