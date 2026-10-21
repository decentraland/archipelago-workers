import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ParcelChangesBatch } from '@dcl/protocol/out-js/decentraland/pulse/pulse_presence.gen'
import { assertCanonicalBatch } from './assert-canonical'

/**
 * C1 of iteration 2: Pulse publishes `decentraland.pulse.ParcelChangesBatch` on the NATS subject
 * `engine.parcel_changes`, and it becomes the only source of online-player information on the
 * platform. Its consumers (comms-gatekeeper, social-service-ea, worlds-content-server) each decode
 * these same bytes with their own generated code.
 *
 * The fixtures under `fixtures/iteration-2/` are byte-identical copies of the contract pack
 * (`aw-contracts/docs/contracts/iteration-2/parcel_changes/`, sha256 per file in its
 * `manifest.json`); `NOTES.json` there says what each one is for. Pulse asserts it *emits* these
 * bytes; this asserts the generated codec reads them back into the documented objects, and writes
 * the same bytes again — so a proto edit that renumbers a field, or stops omitting a proto3
 * default, fails here rather than in a consumer at 3 a.m.
 *
 * ws-connector consumes none of this. It hosts the pins because iteration 2 deletes the `stats`
 * workspace that used to hold the wire-contract tests, and this is the workspace that remains.
 */
const FIXTURES = join(__dirname, 'fixtures', 'iteration-2')

const NAMES = [
  '01-snapshot',
  '02-delta-move',
  '03-exit',
  '04-realm-change',
  '05-coalesced',
  '06-mixed-case',
  '07-invalid-mixed-case-realm',
  '08-gap',
  '09-second-server',
  '10-snapshot-restart'
] as const

function readBin(name: string): Buffer {
  return readFileSync(join(FIXTURES, `${name}.bin`))
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
}

describe('engine.parcel_changes wire contract', () => {
  describe.each(NAMES)('when decoding %s.bin', (name) => {
    /**
     * The expectation is built with the codec's own `fromJSON`, not by hand: the fixture JSON is
     * protobuf-JSON, which omits proto3 defaults (no `"snapshot": false`, no `"x": 0`), and
     * spelling those back out by hand in the spec is exactly the reading the fixture is meant to
     * settle. `fromJSON` fills them the way the proto says, and `decode` has to agree.
     */
    it('should read back the object the fixture json documents', () => {
      const decoded = ParcelChangesBatch.decode(readBin(name))

      expect(decoded).toStrictEqual(ParcelChangesBatch.fromJSON(readJson(name)))
    })

    // The other direction. `decode` alone cannot catch a field that stopped being omitted at its
    // proto3 default, because the reader is happy either way; the bytes are what consumers of a
    // different codegen actually see.
    it('should re-encode to the very same bytes', () => {
      const bin = readBin(name)

      const reencoded = ParcelChangesBatch.encode(ParcelChangesBatch.decode(bin)).finish()

      expect(Buffer.from(reencoded).toString('hex')).toEqual(bin.toString('hex'))
    })
  })

  /**
   * `"parcel": {}` in the fixture json is a present parcel at the world origin — (0,0), a real
   * placement — and not a missing one. On the wire it is a zero-length submessage, which is easy
   * to mistake for absent; a consumer that does drops the peer instead of placing it.
   */
  describe('when a change carries the empty parcel submessage', () => {
    it.each([
      ['01-snapshot', 2, '0x0000000000000000000000000000000000000003'],
      ['09-second-server', 0, '0x0000000000000000000000000000000000000007']
    ])('should read %s change %d as a placement at (0, 0)', (name, index, address) => {
      const change = ParcelChangesBatch.decode(readBin(name)).changes[index]

      expect(change.address).toEqual(address)
      expect(change.parcel).toStrictEqual({ x: 0, y: 0 })
    })
  })

  /**
   * The distinction the origin case exists to protect: no `parcel` key at all means the peer left
   * that realm/instance, and decodes to `undefined` rather than to (0,0).
   */
  describe('when a change carries no parcel at all', () => {
    it('should read the exit in 03-exit as undefined, not as the origin', () => {
      const { changes } = ParcelChangesBatch.decode(readBin('03-exit'))

      expect(changes).toHaveLength(1)
      expect(changes[0].address).toEqual('0x0000000000000000000000000000000000000001')
      expect(changes[0].realm).toEqual('main')
      expect(changes[0].parcel).toBeUndefined()
    })
  })

  /**
   * C1 §5: Pulse lowercases realms and addresses at ingest, so a value that is not already
   * lowercase on the wire means a producer violating the contract. `07-invalid-mixed-case-realm`
   * is that batch — no conforming Pulse emits it, and it exists so every consumer can prove its
   * own guard fires. The guard reports; it is on the consumer not to drop state over it.
   */
  describe('when checking a batch for canonical realms and addresses', () => {
    it.each(NAMES.filter((name) => name !== '07-invalid-mixed-case-realm'))('should accept %s', (name) => {
      expect(() => assertCanonicalBatch(ParcelChangesBatch.decode(readBin(name)))).not.toThrow()
    })

    it('should reject 07-invalid-mixed-case-realm, naming the field and the change', () => {
      const batch = ParcelChangesBatch.decode(readBin('07-invalid-mixed-case-realm'))

      expect(() => assertCanonicalBatch(batch)).toThrow(/realm.*change 0/)
    })

    it('should reject a non-lowercase address just as it rejects a realm', () => {
      const batch = ParcelChangesBatch.decode(readBin('06-mixed-case'))
      batch.changes[0].address = MIXED_CASE_ADDRESS

      expect(() => assertCanonicalBatch(batch)).toThrow(/address.*change 0/)
    })

    /**
     * The helper exists to be copied into every consumer, so its message has to be safe to hand a
     * log line or a crash reporter: an `address` is a wallet, and the first producer regression
     * would otherwise spray one across both. The batch is located by server, seq and change index
     * instead — enough to fetch the offending bytes, nothing to leak.
     */
    it('should not echo the offending value, whichever field it was', () => {
      const withBadAddress = ParcelChangesBatch.decode(readBin('06-mixed-case'))
      withBadAddress.changes[0].address = MIXED_CASE_ADDRESS
      const withBadRealm = ParcelChangesBatch.decode(readBin('07-invalid-mixed-case-realm'))

      const addressError = errorFrom(() => assertCanonicalBatch(withBadAddress))
      expect(addressError.message).not.toContain(MIXED_CASE_ADDRESS)
      expect(addressError.message).not.toContain(MIXED_CASE_ADDRESS.toLowerCase())

      const realmError = errorFrom(() => assertCanonicalBatch(withBadRealm))
      expect(realmError.message).not.toContain(withBadRealm.changes[0].realm)
    })
  })
})

/** The wallet from `06-mixed-case`, re-cased: a value the guard must reject and must not repeat. */
const MIXED_CASE_ADDRESS = '0x00000000000000000000000000000000000000AB'

function errorFrom(run: () => void): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }

  throw new Error('expected assertCanonicalBatch to throw, and it did not')
}
