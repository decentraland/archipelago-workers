'use strict'

// The harness copies two goldens out of the fixture pack. The pack rule is "copy, never reference,
// and keep the bytes identical"; this test is the check. It may read the pack path because the pack
// lives in *this* repository -- a consumer repo's CI has no sibling checkout and must not.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { test, describe } = require('node:test')

const HARNESS = path.dirname(__dirname)
const REPO_ROOT = path.join(HARNESS, '..', '..')
const PACK = path.join(REPO_ROOT, 'docs', 'contracts', 'iteration-2')
const COPIES = path.join(__dirname, 'fixtures', 'iteration-2')

// pack-relative path -> our copy of it
const COPIED = ['http/realms.json', 'http/today/hot-scenes.json']

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

describe('copied fixture-pack goldens', () => {
  test('every copy is byte-identical to its manifest.json entry', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'))

    for (const relative of COPIED) {
      const copy = path.join(COPIES, ...relative.split('/'))
      assert.ok(fs.existsSync(copy), `${relative} was not copied into the harness test tree`)
      assert.equal(manifest.files[relative] !== undefined, true, `${relative} is not in the pack manifest`)
      assert.equal(sha256(copy), manifest.files[relative], `${relative} drifted from the pack`)
    }
  })

  test('the hand-written fixtures are the only other bodies the diffs read', () => {
    const handWritten = ['live-data.json', 'hot-scenes-gatekeeper.json', 'gatekeeper-metrics.txt']
    for (const name of handWritten) {
      assert.ok(fs.existsSync(path.join(__dirname, 'fixtures', name)), `${name} is missing`)
    }
    // The pack has no /live-data golden and no gatekeeper /hot-scenes probe, so those two are
    // hand-written; each says so in its own `note` field.
    for (const name of ['live-data.json', 'hot-scenes-gatekeeper.json']) {
      const body = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
      assert.match(body.note, /hand-written/i, `${name} must say it is hand-written`)
    }
  })

  test('no fixture the harness reads carries a wallet-shaped address', () => {
    const dir = path.join(__dirname, 'fixtures')
    const walk = (at) =>
      fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(at, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    for (const file of walk(dir)) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /0x[0-9a-fA-F]{8,}/, `${file} carries an address`)
    }
  })
})
