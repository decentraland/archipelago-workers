import { AuthChain, AuthLinkType } from '@dcl/schemas'
import { parseEmphemeralPayload } from '@dcl/crypto'
import { normalizeAddress } from './address'

const EPHEMERAL_LINK_TYPES: ReadonlySet<string> = new Set([
  AuthLinkType.ECDSA_PERSONAL_EPHEMERAL,
  AuthLinkType.ECDSA_EIP_1654_EPHEMERAL
])

/**
 * The address that signed the final link of a validated auth chain, lower-cased: the ephemeral
 * (per-device) address when the chain delegates, the wallet itself when it does not. Two devices
 * of one wallet produce different keys; one device's reconnects produce the same one.
 *
 * @param authChain - An auth chain that already passed `Authenticator.validateSignature`.
 * @returns The session key.
 */
export function sessionKeyOf(authChain: AuthChain): string {
  for (let index = authChain.length - 1; index >= 0; index--) {
    const link = authChain[index]
    if (EPHEMERAL_LINK_TYPES.has(link.type)) {
      return normalizeAddress(parseEmphemeralPayload(link.payload).ephemeralAddress)
    }
  }
  return normalizeAddress(authChain[0].payload)
}
