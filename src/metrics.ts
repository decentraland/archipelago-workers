import { IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@well-known-components/metrics'

export const metricDeclarations = {
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
  dcl_archipelago_transports_count: {
    help: 'Number of registered transports',
    type: IMetricsComponent.GaugeType,
    labelNames: ['transport'] // transport=(livekit|ws|p2p)
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
