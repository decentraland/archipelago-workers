export type IDenyListComponent = {
  /**
   * Whether an address is on the platform deny list.
   *
   * Backed by a TTL cache, so most calls are in-memory. Never throws and never fails closed: a
   * fetch failure reports `false` and leaves the last good list in place, because this sits in
   * the WebSocket handshake.
   *
   * @param address - The lower-cased wallet address to check.
   * @returns `true` only when the address is present in the last successfully loaded list.
   */
  isDenylisted(address: string): Promise<boolean>
}
