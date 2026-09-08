'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, describe } = require('node:test')

const {
  counterDelta,
  hasSeries,
  parseLabelFilter,
  parseMetricPage,
  parseScrapeUrls,
  parsePrometheusText,
  sumCounterDeltas,
  sumSeries
} = require('../src/prometheus')

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'gatekeeper-metrics.txt'), 'utf8')

describe('prometheus text parsing', () => {
  test('skips HELP and TYPE lines and keeps one entry per series', () => {
    const samples = parsePrometheusText(SAMPLE)
    assert.equal(samples.length, 8)
    assert.ok(samples.every((sample) => !sample.name.startsWith('#')))
  })

  test('reads the name, the labels and the value', () => {
    const samples = parsePrometheusText(SAMPLE)
    assert.deepEqual(samples[0], { name: 'presence_shadow_diff', labels: { kind: 'land' }, value: 12 })
    assert.deepEqual(samples[2], { name: 'presence_shadow_compare_total', labels: { kind: 'land' }, value: 900 })
    assert.deepEqual(
      samples.find((sample) => sample.name === 'http_requests_total' && sample.labels.code === '200'),
      { name: 'http_requests_total', labels: { method: 'GET', handler: '/scene-participants', code: '200' }, value: 940 }
    )
  })

  test('reads an unlabelled series', () => {
    const samples = parsePrometheusText(SAMPLE)
    const gauge = samples.find((sample) => sample.name === 'dcl_gatekeeper_presence_map_size')
    assert.deepEqual(gauge, { name: 'dcl_gatekeeper_presence_map_size', labels: {}, value: 4218 })
  })

  test('tolerates blank lines, CRLF, a trailing timestamp and NaN', () => {
    const samples = parsePrometheusText('\r\na_total{k="v"} 1 1788515567804\r\n\r\nb_total 3\r\nc_total NaN\r\n')
    assert.deepEqual(samples, [
      { name: 'a_total', labels: { k: 'v' }, value: 1 },
      { name: 'b_total', labels: {}, value: 3 }
    ])
  })

  test('reads exponent notation and a label value containing a comma', () => {
    const samples = parsePrometheusText('a_total{handler="/a,b",code="200"} 1.5e3\n')
    assert.deepEqual(samples, [{ name: 'a_total', labels: { handler: '/a,b', code: '200' }, value: 1500 }])
  })
})

describe('summing series', () => {
  test('sums every series of one metric name', () => {
    const samples = parsePrometheusText(SAMPLE)
    assert.equal(sumSeries(samples, 'presence_shadow_diff'), 15)
    assert.equal(sumSeries(samples, 'presence_shadow_compare_total'), 944)
  })

  test('sums only the series matching the label filter', () => {
    const samples = parsePrometheusText(SAMPLE)
    assert.equal(sumSeries(samples, 'http_requests_total', { handler: '/scene-participants' }), 944)
    assert.equal(sumSeries(samples, 'http_requests_total', { handler: '/hot-scenes' }), 77)
    assert.equal(sumSeries(samples, 'presence_shadow_diff', { kind: 'world' }), 3)
  })

  test('a metric that is not exported at all sums to 0', () => {
    assert.equal(sumSeries(parsePrometheusText(SAMPLE), 'presence_shadow_requests_total'), 0)
  })

  test('hasSeries matches the name AND the label filter, so a filter that hits nothing is visible', () => {
    // A sum of 0 cannot tell "no traffic" from "the filter matches no series at all". Only the
    // second is a configuration error, and only hasSeries can see the difference.
    const samples = parsePrometheusText(SAMPLE)

    assert.equal(hasSeries(samples, 'presence_shadow_compare_total'), true)
    assert.equal(hasSeries(samples, 'presence_shadow_compare_total', { kind: 'land' }), true)
    assert.equal(hasSeries(samples, 'presence_shadow_compare_total', { kind: 'genesis' }), false)
    // The name is exported for other routes, but nothing carries `route=`.
    assert.equal(hasSeries(samples, 'http_requests_total', { handler: '/scene-participants' }), true)
    assert.equal(hasSeries(samples, 'http_requests_total', { route: '/scene-participants' }), false)
    assert.equal(hasSeries(samples, 'not_exported_at_all'), false)
  })

  test('parses a label filter written as a comma-separated string', () => {
    assert.deepEqual(parseLabelFilter('handler=/scene-participants,code=200'), {
      handler: '/scene-participants',
      code: '200'
    })
    assert.deepEqual(parseLabelFilter(''), {})
    assert.deepEqual(parseLabelFilter(undefined), {})
    assert.deepEqual(parseLabelFilter('handler="/scene-participants"'), { handler: '/scene-participants' })
  })

  test('rejects a label filter that is not key=value', () => {
    assert.throws(() => parseLabelFilter('handler'), /label filter/i)
  })
})

describe('counter deltas between two runs', () => {
  test('the delta is the difference since the previous scrape', () => {
    assert.equal(counterDelta(944, 900), 44)
  })

  test('the first ever run takes the whole counter', () => {
    assert.equal(counterDelta(944, undefined), 944)
    assert.equal(counterDelta(944, null), 944)
  })

  test('a counter that went backwards yields no delta at all', () => {
    // A restart (or a scrape that landed on another task) means the window cannot be measured.
    // Taking the whole current value here would report a lifetime counter as one window's traffic.
    assert.equal(counterDelta(12, 900), undefined)
  })

  test('an unchanged counter is a zero delta, not a missing sample', () => {
    assert.equal(counterDelta(900, 900), 0)
  })
})

describe('scrape targets', () => {
  test('a comma-separated list of URLs becomes one target per task', () => {
    assert.deepEqual(parseScrapeUrls('https://a.example.com/metrics'), ['https://a.example.com/metrics'])
    assert.deepEqual(parseScrapeUrls(' https://a.example.com/metrics , https://b.example.com/metrics '), [
      'https://a.example.com/metrics',
      'https://b.example.com/metrics'
    ])
    // A repeated or empty entry is an env-file typo, not a second task.
    assert.deepEqual(parseScrapeUrls('https://a.example.com/metrics,,https://a.example.com/metrics'), [
      'https://a.example.com/metrics'
    ])
  })

  test('an empty list is rejected rather than scraping nothing', () => {
    assert.throws(() => parseScrapeUrls('   '), /at least one/i)
    assert.throws(() => parseScrapeUrls(','), /at least one/i)
  })
})

describe('summing counter deltas across targets', () => {
  const A = 'https://a.example.com/metrics'
  const B = 'https://b.example.com/metrics'

  test('each target is subtracted against its own previous scrape, then summed', () => {
    const result = sumCounterDeltas(
      { [A]: { compare: 100, diff: 5 }, [B]: { compare: 40, diff: 1 } },
      { [A]: { compare: 90, diff: 4 }, [B]: { compare: 30, diff: 1 } }
    )

    assert.deepEqual(result.deltas, { compare: 20, diff: 1 })
    assert.deepEqual(result.wentBackwards, [])
    assert.deepEqual(result.newTargets, [])
  })

  test('a target with no previous scrape contributes its whole counter and is named', () => {
    const result = sumCounterDeltas({ [A]: { compare: 100 }, [B]: { compare: 7 } }, { [A]: { compare: 90 } })

    assert.deepEqual(result.deltas, { compare: 17 }, '10 measured on A, 7 lifetime on the task that just appeared')
    assert.deepEqual(result.newTargets, [B])
  })

  test('the first ever run has no previous state at all', () => {
    const result = sumCounterDeltas({ [A]: { compare: 100 } }, undefined)
    assert.deepEqual(result.deltas, { compare: 100 })
    assert.deepEqual(result.newTargets, [A])
  })

  test('a target whose counter went backwards is named and nothing is summed for it', () => {
    const result = sumCounterDeltas(
      { [A]: { compare: 100 }, [B]: { compare: 3 } },
      { [A]: { compare: 90 }, [B]: { compare: 60 } }
    )

    assert.deepEqual(result.wentBackwards, [B])
    assert.equal(result.deltas.compare, 10, 'the sound target is still measured; the caller decides what to do')
  })
})

describe('declared metric names (# TYPE / # HELP)', () => {
  test('a page declares every registered metric, samples or not', () => {
    // prom-client emits `# HELP` / `# TYPE` for every registered metric but no sample line for a
    // labelled counter until its first inc(), so the TYPE line is the only evidence that a freshly
    // started task knows the metric at all. Discarding it makes "registered, zero comparisons so
    // far" indistinguishable from "wrong metric name".
    const { samples, declared } = parseMetricPage(SAMPLE)

    assert.equal(samples.length, 8, 'the samples are exactly what parsePrometheusText returns')
    assert.deepEqual(
      [...declared].sort(),
      [
        'dcl_gatekeeper_presence_map_size',
        'http_requests_total',
        'presence_shadow_compare_total',
        'presence_shadow_diff'
      ]
    )
  })

  test('a counter declared with no sample lines yet is declared and unsampled', () => {
    const page = [
      '# HELP presence_shadow_compare_total Total /scene-participants shadow comparisons',
      '# TYPE presence_shadow_compare_total counter',
      ''
    ].join('\n')
    const { samples, declared } = parseMetricPage(page)

    assert.deepEqual(samples, [], 'no inc() has happened, so there is no series')
    assert.equal(declared.has('presence_shadow_compare_total'), true)
  })

  test('parsePrometheusText still returns the samples alone', () => {
    assert.deepEqual(parsePrometheusText(SAMPLE), parseMetricPage(SAMPLE).samples)
    assert.equal(parsePrometheusText('# TYPE a_total counter\n').length, 0)
  })

  test('a malformed or unnamed comment line declares nothing', () => {
    const { declared } = parseMetricPage('# a free-form comment\n# TYPE\n#HELP b_total help text\n')
    assert.deepEqual([...declared], ['b_total'], 'no space after # is still a valid comment line')
  })
})
