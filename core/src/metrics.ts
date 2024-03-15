import { IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@well-known-components/metrics'
import { getDefaultHttpMetrics } from '@well-known-components/http-server'
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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
