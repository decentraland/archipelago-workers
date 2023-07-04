// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment

import { createRunner, createLocalFetchCompoment } from '@well-known-components/test-helpers'

import { main } from '../src/service'
import { TestComponents } from '../src/types'
import { initComponents as originalInitComponents } from '../src/components'
import { createLocalNatsComponent } from '@well-known-components/nats-component/dist/test-component'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../src/metrics'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'

/**
 * Behaves like Jest "describe" function, used to describe a test for a
 * use case, it creates a whole new program and components to run an
 * isolated test.
 *
 * State is persistent within the steps of the test.
 */
export const test = createRunner<TestComponents>({
  main,
  initComponents
})

async function initComponents(): Promise<TestComponents> {
  const components = await originalInitComponents()
  const config = createConfigComponent({
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_HOST: 'wss://test-livekit',
    ...process.env,
    LOG_LEVEL: 'INFO',
    HANDSHAKE_TIMEOUT: '100'
  })

  const nats = await createLocalNatsComponent()

  return {
    ...components,
    logs: await createLogComponent({ config }),
    config,
    localFetch: await createLocalFetchCompoment(config),
    nats: nats,
    metrics: createTestMetricsComponent(metricDeclarations)
  }
}
