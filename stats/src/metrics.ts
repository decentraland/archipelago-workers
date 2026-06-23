import { validateMetricsDeclaration } from '@dcl/metrics'
import { getDefaultHttpMetrics } from '@dcl/http-server'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
