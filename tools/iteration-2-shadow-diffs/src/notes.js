'use strict'

// The `notes` field is read by a human in a Notion table, so it stays short and carries no
// identifier that could be a wallet: world names and scene ids only.

const MAX_NOTES = 380

// `a, b, c + 37 more` -- sorted so two runs over the same difference read the same.
const boundedList = (values, max = 5) => {
  const sorted = [...values].sort()
  const head = sorted.slice(0, max).join(', ')
  return sorted.length > max ? `${head} + ${sorted.length - max} more` : head
}

// Last-resort guard: a pathological answer must not write a 40 kB notes field into the .jsonl.
const clampNotes = (text, max = MAX_NOTES) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

const joinNotes = (parts) => clampNotes(parts.filter((part) => part !== undefined && part !== '').join('; '))

module.exports = { MAX_NOTES, boundedList, clampNotes, joinNotes }
