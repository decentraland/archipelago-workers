import { ServiceDiscoveryMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { IBaseComponent } from '@well-known-components/interfaces'

export type ICoreStatusComponent = IBaseComponent & {
  onServiceDiscoveryReceived(message: ServiceDiscoveryMessage): void
  isHealthy(): boolean
  getUserCount(): number
}

export function createCoreStatusComponent(): ICoreStatusComponent {
  let isHealthy = false
  let userCount = 0
  return {
    onServiceDiscoveryReceived(message: ServiceDiscoveryMessage) {
      isHealthy = true
      userCount = message.status?.userCount ?? 0
    },
    isHealthy: () => isHealthy,
    getUserCount: () => userCount
  }
}
