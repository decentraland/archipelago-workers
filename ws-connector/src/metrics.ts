import { validateMetricsDeclaration } from '@dcl/metrics'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics } from '@dcl/uws-http-server'
import { IMetricsComponent } from '@well-known-components/interfaces'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  // A completed handshake whose `peer.<address>.connect` the NATS client refused, so
  // comms-gatekeeper was never asked to re-emit that peer's island assignment: the client holds a
  // live socket with no island until its cluster changes. Nothing else about such a session looks
  // wrong from the outside, which is why it needs a counter of its own.
  //
  // It counts refusals only — the component was never started, or the connection is closed. A
  // publish made while the client is *reconnecting* is buffered instead, and dropped silently if
  // the reconnect never succeeds, so this series cannot prove that announcements are landing:
  // that check is a `peer.*.connect` subscription on the broker
  // (docs/stats-decommission-runbook.md §7).
  ws_connector_peer_connect_publish_failures_total: {
    help: "Handshake announcements ('peer.<address>.connect') the NATS client refused (not started / closed)",
    type: IMetricsComponent.CounterType
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
