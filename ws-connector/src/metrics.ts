import { validateMetricsDeclaration } from '@dcl/metrics'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics } from '@dcl/uws-http-server'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  dcl_ws_connector_supersede_cooldown_refusals_total: {
    help: 'Total handshakes refused because the address was superseded moments earlier',
    type: IMetricsComponent.CounterType
  },
  dcl_ws_connector_supersede_kicks_total: {
    help: 'Total sessions kicked because a newer session for the same address was announced',
    type: IMetricsComponent.CounterType
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
