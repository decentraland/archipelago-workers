import { IBaseComponent } from '@well-known-components/interfaces'

export type ISupersedeCooldownComponent = IBaseComponent & {
  /**
   * Records that the address's live session was just kicked in favour of a newer one.
   *
   * @param address - The peer's lower-cased address.
   */
  onSuperseded(address: string): void
  /**
   * @param address - The peer's lower-cased address.
   * @returns Whether the address was superseded recently enough that a handshake for it should
   * be refused.
   */
  isCoolingDown(address: string): boolean
  /** Number of addresses held, including any whose window has elapsed but not been read. */
  size(): number
}
