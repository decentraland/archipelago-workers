'use strict'

// Every diff ends the same way: build the shared report line, append it to
// `${OUT_DIR}/<diff>.jsonl`, print the human summary, hand the line back.

const {
  appendReportLine,
  buildReportLine,
  formatHumanSummary,
  resolveEnvLabel,
  resolveOutDir,
  resolveTolerance
} = require('./report')

const finishRun = ({ diff, env = {}, now = () => new Date(), out = console.log, counts, explainedBy, notes }) => {
  const line = buildReportLine({
    diff,
    at: now().toISOString(),
    env: resolveEnvLabel(env),
    sampleSize: counts.sampleSize,
    agree: counts.agree,
    onlyLegacy: counts.onlyLegacy,
    onlyPulse: counts.onlyPulse,
    tolerance: resolveTolerance(diff, env),
    explainedBy,
    notes
  })
  appendReportLine(resolveOutDir(env), line)
  out(formatHumanSummary(line))
  return line
}

module.exports = { finishRun }
