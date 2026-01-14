import { validateMetricsDeclaration } from '@well-known-components/metrics'
import { getDefaultHttpMetrics } from '@dcl/wkc-http-server'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
