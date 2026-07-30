import { peersHandler } from '../../src/controllers/handlers/peers-handler'
import { createStatsComponent } from '../../src/adapters/stats'
import { PeerData } from '../../src/types'
import { coreStatusHandler } from '../../src/controllers/handlers/core-status-handler'
import { createCoreStatusComponent } from '../../src/adapters/core-status'
import { createClockComponent } from '../../src/adapters/clock'

describe('core-status-handler-unit', () => {

  it('if no discovery message, core is unhealthy', async () => {
    const url = new URL('https://localhost/core-status')
    const clock = createClockComponent()
    const coreStatus = createCoreStatusComponent({ clock })
    const {
      body: { healthy, userCount }
    } = await coreStatusHandler({ url, components: { coreStatus } })
    expect(healthy).toEqual(false)
    expect(userCount).toEqual(0)
  })

  it('if last discovery message is older than 90 seconds, core is unhealthy', async () => {
    const url = new URL('https://localhost/core-status')
    const now = Date.now()
    const clock = {
      now: () => now
    }
    const coreStatus = createCoreStatusComponent({ clock })
    coreStatus.onServiceDiscoveryReceived({
      serverName: 'name',
      status: {
        currentTime: now - 90000,
        userCount: 10,
      }
    })
    const {
      body: { healthy, userCount }
    } = await coreStatusHandler({ url, components: { coreStatus } })
    expect(healthy).toEqual(false)
    expect(userCount).toEqual(10)
  })

  it('if the discovery timestamp is far in the future, the publisher is not healthy', async () => {
    const url = new URL('https://localhost/core-status')
    const now = Date.now()
    const clock = {
      now: () => now
    }
    const coreStatus = createCoreStatusComponent({ clock })
    coreStatus.onServiceDiscoveryReceived({
      serverName: 'pulse',
      status: {
        currentTime: now + 3600000,
        userCount: 3000
      }
    })
    const {
      body: { healthy }
    } = await coreStatusHandler({ url, components: { coreStatus } })
    expect(healthy).toEqual(false)
  })

  it('tolerates a small clock difference in either direction', async () => {
    const url = new URL('https://localhost/core-status')
    const now = Date.now()
    const clock = {
      now: () => now
    }
    const coreStatus = createCoreStatusComponent({ clock })
    coreStatus.onServiceDiscoveryReceived({
      serverName: 'pulse',
      status: {
        currentTime: now + 5000,
        userCount: 10
      }
    })
    const {
      body: { healthy }
    } = await coreStatusHandler({ url, components: { coreStatus } })
    expect(healthy).toEqual(true)
  })

  it('if last discovery is newer than 90 seconds, core is healthy', async () => {
    const url = new URL('https://localhost/core-status')
    const now = Date.now()
    const clock = {
      now: () => now
    }
    const coreStatus = createCoreStatusComponent({ clock })
    coreStatus.onServiceDiscoveryReceived({
      serverName: 'name',
      status: {
        currentTime: now - 89999,
        userCount: 10,
      }
    })
    const {
      body: { healthy, userCount }
    } = await coreStatusHandler({ url, components: { coreStatus } })
    expect(healthy).toEqual(true)
    expect(userCount).toEqual(10)
  })
})
