'use strict'
/**
 * Writes manifest.json: sha256 of every fixture file in the pack (everything except manifest.json,
 * README.md and tools/). Repos copy fixtures into their own test trees; the validator compares the
 * copies against these hashes so a fixture can never drift silently.
 *
 *   node tools/manifest.js          # (re)write manifest.json
 *   node tools/manifest.js --check  # exit 1 if any hashed file changed or is missing
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const CHECK = process.argv.includes('--check')
const SKIP = new Set(['manifest.json', 'README.md', 'ROLLOUT-INFRA.md', '.gitattributes', 'tools'])

function walk(dir, rel = '') {
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!rel && SKIP.has(name)) continue
    const full = path.join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, r))
    else out.push(r)
  }
  return out
}

const files = {}
for (const rel of walk(ROOT)) {
  files[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex')
}
const manifest = { generatedBy: 'tools/manifest.js', files }
const full = path.join(ROOT, 'manifest.json')
const buf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')

if (CHECK) {
  const cur = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : { files: {} }
  let failures = 0
  for (const [rel, sha] of Object.entries(files)) if (cur.files[rel] !== sha) { failures++; console.error(`CHANGED/NEW ${rel}`) }
  for (const rel of Object.keys(cur.files)) if (!files[rel]) { failures++; console.error(`MISSING ${rel}`) }
  if (failures) process.exit(1)
  console.log(`manifest: ${Object.keys(files).length} files match`)
} else {
  fs.writeFileSync(full, buf)
  console.log(`manifest: ${Object.keys(files).length} files hashed`)
}
