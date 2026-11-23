// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment

import { createRunner, createLocalFetchComponent } from '@dcl/test-helpers'

import { existsSync } from 'fs'
import { resolve } from 'path'
import { main } from '../src/service'
import { TestComponents } from '../src/types'
import { initComponents as originalInitComponents } from '../src/components'
import { createLocalNatsComponent } from '@well-known-components/nats-component/dist/test-component'
import { createTestMetricsComponent } from '@dcl/metrics'
import { metricDeclarations } from '../src/metrics'
import { createConfigComponent, createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
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

/**
 * This workspace's dotenv files, absolute, in production's precedence order (`.env` overrides
 * `.env.default`), skipping the ones that are not there — `.env` is gitignored and absent on CI,
 * and a missing path makes the loader warn.
 */
function workspaceDotEnvPaths(): string[] {
  const workspaceRoot = resolve(__dirname, '..')
  return [resolve(workspaceRoot, '.env.default'), resolve(workspaceRoot, '.env')].filter((path) => existsSync(path))
}

async function initComponents(): Promise<TestComponents> {
  // `src/components.ts` resolves ['.env.default', '.env'] against the *process cwd*, which is this
  // workspace only when jest was started from it. The root `yarn test` also runs an aggregate
  // `jest --runInBand` from the repo root — and the Dockerfile's `RUN yarn test` does the same at
  // /app — where those relative names hit the ROOT `.env.default`, a different file that carries
  // none of this workspace's keys. So load this workspace's files by absolute path first, and
  // every suite that reads a value the service actually ships (see the "left to the shipped
  // default" program in test/integration/heartbeat-forwarding.spec.ts) stops depending on where
  // jest was started. Precedence is untouched: the loader never overwrites a key the environment
  // already carries, so an explicit `process.env` override — how a suite hands the program its
  // config — still wins, and the cwd-relative load inside `originalInitComponents` still runs.
  await createDotEnvConfigComponent({ path: workspaceDotEnvPaths() })

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
    localFetch: await createLocalFetchComponent(config),
    nats: nats,
    metrics: createTestMetricsComponent(metricDeclarations)
  }
}
