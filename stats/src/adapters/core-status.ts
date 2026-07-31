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
    // Healthy when the last heartbeat is under 90s old. Absolute delta: `currentTime` is
    // stamped on the publisher's host, so forward clock skew must not read as fresh.
    isHealthy: () => !!lastMessage?.status && Math.abs(clock.now() - lastMessage.status.currentTime) < 90000,
    getUserCount: () => lastMessage?.status?.userCount ?? 0
  }
}
