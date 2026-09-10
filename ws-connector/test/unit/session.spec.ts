import { Authenticator } from '@dcl/crypto'
import { sessionKeyOf } from '../../src/logic/session'
import { createEphemeralIdentity } from '../helpers/identity'

describe('session key', () => {
  describe('when the auth chain delegates to an ephemeral key', () => {
    const identity = createEphemeralIdentity('session-spec')

    it('should be the lower-cased ephemeral address', async () => {
      const chain = await identity.sign('dcl-challenge')

      expect(sessionKeyOf(chain)).toBe(identity.ephemeralAddress.toLowerCase())
    })

    it('should differ between two devices of the same wallet', async () => {
      const otherDevice = createEphemeralIdentity('session-spec', 'laptop')

      expect(otherDevice.address).toBe(identity.address)
      expect(sessionKeyOf(await otherDevice.sign('dcl-challenge'))).not.toBe(
        sessionKeyOf(await identity.sign('dcl-challenge'))
      )
    })

    it('should be stable across signatures from the same device', async () => {
      expect(sessionKeyOf(await identity.sign('one'))).toBe(sessionKeyOf(await identity.sign('two')))
    })
  })

  describe('when the auth chain has no delegation', () => {
    it('should fall back to the lower-cased wallet', () => {
      const chain = Authenticator.createSimpleAuthChain(
        'dcl-challenge',
        '0xAaBbCcDdEeFf00112233445566778899aAbBcCdD',
        'sig'
      )

      expect(sessionKeyOf(chain)).toBe('0xaabbccddeeff00112233445566778899aabbccdd')
    })
  })
})
