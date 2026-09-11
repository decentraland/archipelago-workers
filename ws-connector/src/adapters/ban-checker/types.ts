export type IBanCheckerComponent = {
  /**
   * Asks comms-gatekeeper whether an address is platform-banned.
   *
   * Never throws and never fails closed: an unset `COMMS_GATEKEEPER_URL` (local dev), a non-OK
   * response, or a network error all report `false`. A gatekeeper outage must not lock everyone
   * out of the platform.
   *
   * @param address - The lower-cased wallet address to check.
   * @returns `true` only when the gatekeeper positively reports a ban.
   */
  isBanned(address: string): Promise<boolean>
}
