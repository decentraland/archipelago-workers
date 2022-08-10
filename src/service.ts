import { Lifecycle } from '@well-known-components/interfaces'
import { setupIslandsStatusReporting } from './controllers/islands-status-report'
import { setupListener } from './controllers/listener'
import { setupMetrics } from './controllers/metrics'
import { setupPublishing } from './controllers/publish'
import { setupRouter } from './controllers/routes'
import { setupServiceDiscovery } from './controllers/service-discovery'
import { AppComponents, GlobalContext, TestComponents } from './types'

type Startable = {
  start(): Promise<void>
}

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, config, logs, metrics, archipelago } = components

  const start = async (s: Promise<Startable>) => {
    const { start } = await s
    await start()
  }

  await setupListener({ nats, archipelago, config, logs })
  await setupPublishing({ nats, archipelago })
  await start(setupServiceDiscovery({ nats, logs, config }))
  await start(setupMetrics({ config, logs, metrics, archipelago }))
  await start(setupIslandsStatusReporting({ nats, logs, config, archipelago }))
}
