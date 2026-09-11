import { validateMetricsDeclaration } from '@dcl/metrics'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics } from '@dcl/uws-http-server'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  dcl_ws_connector_island_changed_no_session_socket_total: {
    help: 'Total session-addressed island_changed messages for a wallet this replica holds, but not under that session',
    type: IMetricsComponent.CounterType
  },
  dcl_ws_connector_island_changed_deduplicated_total: {
    help: 'Total island_changed messages dropped because the same island was forwarded to the same socket within ISLAND_CHANGED_DEDUP_MS',
    type: IMetricsComponent.CounterType
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
