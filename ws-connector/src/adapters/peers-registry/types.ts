import { IBaseComponent } from '@well-known-components/interfaces'
import { InternalWebSocket } from '../../types'

export type RegisteredPeer = { id: string; session: string; ws: InternalWebSocket }

export type IPeersRegistryComponent = IBaseComponent & {
  /**
   * Registers a session's live socket, replacing any socket already held for that exact
   * (id, session) pair and leaving the wallet's other sessions untouched.
   *
   * @param id - The peer's lower-cased address. Lookups are exact string matches.
   * @param session - The peer's lower-cased session key (see `logic/session.ts`).
   * @param ws - The peer's WebSocket.
   */
  onPeerConnected(id: string, session: string, ws: InternalWebSocket): void
  /**
   * Removes a session's socket, but only if the registry still points at this exact socket.
   *
   * @param id - The peer's lower-cased address.
   * @param session - The peer's lower-cased session key.
   * @param ws - The socket that closed.
   */
  onPeerDisconnected(id: string, session: string, ws: InternalWebSocket): void
  /**
   * @returns The socket held for this exact (id, session), or `undefined`.
   */
  getPeerWs(id: string, session: string): InternalWebSocket | undefined
  /**
   * @returns The most recently registered socket of any session of the wallet, or `undefined`.
   * Used only for the legacy, session-less `island_changed` subject.
   */
  getNewestPeerWs(id: string): InternalWebSocket | undefined
  /** Whether any session of the wallet is connected to this replica. */
  hasPeer(id: string): boolean
  /** Number of sockets currently connected to this replica. */
  getPeerCount(): number
  /**
   * Returns a point-in-time copy of the registry. Used by the ban sweep so iteration is safe
   * under concurrent connect/disconnect.
   */
  snapshot(): RegisteredPeer[]
}
