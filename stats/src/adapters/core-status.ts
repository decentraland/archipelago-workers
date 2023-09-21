import { ServiceDiscoveryMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { IBaseComponent } from '@well-known-components/interfaces'
import { BaseComponents } from '../types'

export type ICoreStatusComponent = IBaseComponent & {
  onServiceDiscoveryReceived(message: ServiceDiscoveryMessage): void
  isHealthy(): boolean
  getUserCount(): number
}

export function createCoreStatusComponent({ clock }: Pick<BaseComponents, 'clock'>): ICoreStatusComponent {
  let lastMessage: ServiceDiscoveryMessage | undefined = undefined
  return {
    onServiceDiscoveryReceived(message: ServiceDiscoveryMessage) {
      lastMessage = message
    },
    // If last heartbeat is less than 90 seconds old, we consider the service healthy
    isHealthy: () => !!lastMessage?.status && clock.now() - lastMessage.status.currentTime < 90000,
    getUserCount: () => lastMessage?.status?.userCount ?? 0
  }
}
