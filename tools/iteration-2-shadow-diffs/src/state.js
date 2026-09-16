'use strict'

// Per-env, per-diff state carried between cron runs (diff 1 needs the previous counter values).
//
// The file is keyed by BOTH the environment label and the diff name, because `OUT_DIR` may be
// shared between the `zone` and `org` crons: the report lines carry their own `env` and the summary
// splits on it, but two environments' counters are unrelated numbers, so one shared state file
// would make each run read the other deployment's lifetime counters as its own previous scrape.
//
// A corrupt or half-written file must never take the cron down: it reads as "no previous run",
// which the diffs already handle as a first run.

const fs = require('node:fs')
const path = require('node:path')

const STATE_DIR = 'state'

// The env label comes from a cron env file and ends up in a path, so it is reduced to a safe
// basename: no separator, no `..`, nothing that could write outside `${OUT_DIR}/state`.
const safeLabel = (value) => {
  const label = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
  return label === '' ? 'unknown' : label
}

const stateFile = (dir, diff, envLabel) =>
  path.join(dir, STATE_DIR, `${safeLabel(envLabel)}-${safeLabel(diff)}.json`)

const readState = (dir, diff, envLabel) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(dir, diff, envLabel), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

const writeState = (dir, diff, envLabel, state) => {
  const file = stateFile(dir, diff, envLabel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write-then-rename so a killed cron leaves the previous state intact instead of a truncated file.
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return file
}

module.exports = { STATE_DIR, readState, safeLabel, stateFile, writeState }
