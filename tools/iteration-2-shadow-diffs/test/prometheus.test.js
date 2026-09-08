'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, describe } = require('node:test')

const { counterDelta, parseLabelFilter, parsePrometheusText, sumSeries } = require('../src/prometheus')

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'gatekeeper-metrics.txt'), 'utf8')

describe('prometheus text parsing', () => {
  test('skips HELP and TYPE lines and keeps one entry per series', () => {
    const samples = parsePrometheusText(SAMPLE)
    assert.equal(samples.length, 6)
    assert.ok(samples.every((sample) => !sample.name.startsWith('#')))
  })

  test('reads the name, the labels and the value', () => {
    const samples = parsePrometheusText(SAMPLE)
    assert.deepEqual(samples[0], { name: 'presence_shadow_diff', labels: { kind: 'land' }, value: 12 })
    assert.deepEqual(samples[2], {
      name: 'http_requests_total',
      labels: { method: 'GET', handler: '/scene-participants', code: '200' },
      value: 940
    })
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
