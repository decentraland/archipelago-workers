#!/usr/bin/env node
'use strict'

// One entry point for all four diffs and the window summary. Configuration is entirely
// environment; see README.md for the variables each diff needs and the cron lines.

const { DIFF_NAMES } = require('../src/report')
const { runSummarize } = require('../src/summarize')

const DIFFS = {
  'scene-participants': () => require('../src/diffs/scene-participants'),
  'live-data': () => require('../src/diffs/live-data'),
  'online-set': () => require('../src/diffs/online-set'),
  'hot-scenes': () => require('../src/diffs/hot-scenes')
}

const USAGE = `shadow-diff — iteration-2 shadow diffs (Pulse vs LiveKit/heartbeats)

  shadow-diff <diff>                 run one diff once and append a line to $OUT_DIR/<diff>.jsonl
  shadow-diff summarize <diff> [..]  aggregate a window and print the Markdown table
                                     [--window-days N] [--env zone|org] [--gate]

  diffs: ${DIFF_NAMES.join(', ')}

  --gate exits 1 when the window is out of tolerance (for the cut-over check); a single run
  never exits non-zero on its verdict alone, only on a failure to collect it.`

const main = async (argv) => {
  const command = argv[0]

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return command === undefined ? 1 : 0
  }

  if (command === 'summarize') {
    const gate = argv.includes('--gate')
    const { aggregate } = runSummarize({
      argv: argv.slice(1).filter((arg) => arg !== '--gate'),
      env: process.env
    })
    return gate && !aggregate.withinTolerance ? 1 : 0
  }

  if (!Object.hasOwn(DIFFS, command)) {
    console.error(`unknown diff "${command}"\n\n${USAGE}`)
    return 1
  }

  await DIFFS[command]().run({ env: process.env })
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    // A collection failure must be loud: a missing URL or an unreachable endpoint is not a clean run.
    console.error(`shadow-diff failed: ${error.message}`)
    process.exitCode = 1
  })
