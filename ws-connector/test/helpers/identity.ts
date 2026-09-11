import { createIdentity } from 'eth-crypto'
import { Authenticator } from '@dcl/crypto'
import { sha512 } from 'ethereum-cryptography/sha512'
import { utf8ToBytes } from 'ethereum-cryptography/utils'

/**
 * A wallet plus one device's ephemeral key. Two calls with the same `entropy` and different
 * `deviceEntropy` are the same wallet signed in from two devices, which is exactly what a session
 * takeover looks like on the wire.
 */
export function createEphemeralIdentity(entropy?: string, deviceEntropy = 'ephemeral') {
  const theRealEntropy = entropy
    ? Buffer.concat([sha512(utf8ToBytes(entropy)), sha512(utf8ToBytes(entropy))])
    : undefined
  const theRealEntropyEphemeral = entropy
    ? Buffer.concat([sha512(utf8ToBytes(entropy + deviceEntropy)), sha512(utf8ToBytes(entropy))])
    : undefined
  const realIdentity = createIdentity(theRealEntropy)
  const ephemeral = createIdentity(theRealEntropyEphemeral)

  return {
    address: realIdentity.address,
    ephemeralAddress: ephemeral.address,
    async sign(message: string) {
      return Authenticator.createAuthChain(realIdentity, ephemeral, 10, message)
    }
  }
}
