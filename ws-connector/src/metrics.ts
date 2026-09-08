import { validateMetricsDeclaration } from '@dcl/metrics'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics } from '@dcl/uws-http-server'
import { IMetricsComponent } from '@well-known-components/interfaces'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  // A completed handshake whose `peer.<address>.connect` never reached the broker, so
  // comms-gatekeeper was never asked to re-emit that peer's island assignment: the client holds a
  // live socket with no island until its cluster changes. Nothing else about such a session looks
  // wrong from the outside, which is why it needs a counter of its own.
  ws_connector_peer_connect_publish_failures_total: {
    help: "Handshake announcements ('peer.<address>.connect') that could not be published on NATS",
    type: IMetricsComponent.CounterType
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
