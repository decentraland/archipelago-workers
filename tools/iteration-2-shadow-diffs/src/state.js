'use strict'

// Per-diff state carried between cron runs (diff 1 needs the previous counter values). A corrupt
// or half-written file must never take the cron down: it reads as "no previous run", which the
// diffs already handle as a first run.

const fs = require('node:fs')
const path = require('node:path')

const stateFile = (dir, diff) => path.join(dir, `${diff}.state.json`)

const readState = (dir, diff) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(dir, diff), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

const writeState = (dir, diff, state) => {
  fs.mkdirSync(dir, { recursive: true })
  const file = stateFile(dir, diff)
  // Write-then-rename so a killed cron leaves the previous state intact instead of a truncated file.
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return file
}

module.exports = { readState, stateFile, writeState }
