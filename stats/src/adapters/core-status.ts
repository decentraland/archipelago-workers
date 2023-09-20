import { ServiceDiscoveryMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { IBaseComponent } from '@well-known-components/interfaces'

export type ICoreStatusComponent = IBaseComponent & {
  onServiceDiscoveryReceived(message: ServiceDiscoveryMessage): void
  isHealthy(): boolean
  getUserCount(): number
}

export function createCoreStatusComponent(): ICoreStatusComponent {
  let lastMessage: ServiceDiscoveryMessage | undefined = undefined
  return {
    onServiceDiscoveryReceived(message: ServiceDiscoveryMessage) {
      lastMessage = message
    },
    isHealthy: () => {
      const now = Date.now()
      // If last heartbeat is less than 90 seconds old, we consider the service healthy
      if (lastMessage?.status && now - lastMessage.status.currentTime < 90000) {
        return true
      }
      return false
    },
    getUserCount: () => lastMessage?.status?.userCount ?? 0
  }
}
