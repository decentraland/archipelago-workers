import { Lifecycle } from '@well-known-components/interfaces'
import { AppComponents, TestComponents } from './types'
import { setupListener } from './adapters/listener'

const DEFAULT_ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL = 1000 * 60 * 2 // 2 min
const DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL = 10000

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, config, logs, publisher, engine } = components

  const logger = logs.getLogger('service')

  const islandsStatusUpdateFreq =
    (await config.getNumber('ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL')) ??
    DEFAULT_ARCHIPELAGO_ISLANDS_STATUS_UPDATE_INTERVAL
  setInterval(() => {
    try {
      publisher.publishIslandsReport(engine.getIslands())
    } catch (err: any) {
      logger.error(err)
    }
  }, islandsStatusUpdateFreq)

  const serviceDiscoveryUpdateFreq =
    (await config.getNumber('ARCHIPELAGO_STATUS_UPDATE_INTERVAL')) ?? DEFAULT_ARCHIPELAGO_STATUS_UPDATE_INTERVAL

  setInterval(() => {
    try {
      publisher.publishServiceDiscoveryMessage(engine.getPeerCount())
    } catch (err: any) {
      logger.error(err)
    }
  }, serviceDiscoveryUpdateFreq)

  await setupListener(engine, { nats, config, logs })
}
