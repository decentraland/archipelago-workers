import { IBaseComponent } from '@well-known-components/interfaces'
import { InternalWebSocket } from '../../types'

export type WsApp = {
  publish(topic: string, payload: Uint8Array, binary: boolean): void
}

export type IPeersRegistryComponent = IBaseComponent & {
  /**
   * Registers a peer's live socket, replacing any socket already held for that id.
   *
   * @param id - The peer's lower-cased address. Lookups are exact string matches, so a
   * checksummed address here would silently make the peer unreachable from the island feed.
   * @param ws - The peer's WebSocket.
   */
  onPeerConnected(id: string, ws: InternalWebSocket): void
  /**
   * Removes a peer, but only if the registry still points at this exact socket.
   *
   * @param id - The peer's lower-cased address.
   * @param ws - The socket that closed.
   */
  onPeerDisconnected(id: string, ws: InternalWebSocket): void
  /**
   * @param id - The peer's lower-cased address.
   * @returns The peer's live socket, or `undefined` when it is not connected here.
   */
  getPeerWs(id: string): InternalWebSocket | undefined
  /** Number of peers currently connected to this replica. */
  getPeerCount(): number
  /**
   * Returns a point-in-time copy of the registry. Used by the ban sweep so iteration is safe
   * under concurrent connect/disconnect.
   */
  snapshot(): { id: string; ws: InternalWebSocket }[]
}
