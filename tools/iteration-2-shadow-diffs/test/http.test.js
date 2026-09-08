'use strict'

// The only tests that drive the real `fetch` path. Every diff injects `fetchJson` / `fetchText`, so
// without these the timeout, the non-2xx throw, the `accept` handling and the bearer header are
// exercised by nothing at all -- and the 401 that a bearer-protected `/metrics` answers, and the
// 503 that a warming gatekeeper answers, are the two branches diff 1 and diff 4 turn on.
//
// No dependency and no fixture server framework: `node:http` on an ephemeral port.

const assert = require('node:assert/strict')
const http = require('node:http')
const { test, describe, after } = require('node:test')

const { authHeaders, bearerToken, fetchJson, fetchText, joinUrl, requireEnv } = require('../src/http')

const TOKEN = 'not-a-real-token-0000'

const servers = []

// Starts a server whose handler is swapped per test; returns its base URL.
const serve = async (handler) => {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
})

describe('http: the real GET path', () => {
  test('fetchJson parses the body and asks for JSON', async () => {
    const seen = []
    const base = await serve((request, response) => {
      seen.push({ url: request.url, accept: request.headers.accept, auth: request.headers.authorization })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ realms: [{ name: 'a.dcl.eth', peers: 2 }] }))
    })

    const body = await fetchJson(joinUrl(base, '/realms'))

    assert.deepEqual(body, { realms: [{ name: 'a.dcl.eth', peers: 2 }] })
    assert.equal(seen[0].url, '/realms')
    assert.equal(seen[0].accept, 'application/json')
    assert.equal(seen[0].auth, undefined, 'no header without a token')
  })

  test('fetchText returns the body and asks for text', async () => {
    const seen = []
    const base = await serve((request, response) => {
      seen.push(request.headers.accept)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('presence_shadow_compare_total{kind="land"} 7\n')
    })

    const text = await fetchText(joinUrl(base, '/metrics'))

    assert.match(text, /presence_shadow_compare_total/)
    assert.equal(seen[0], 'text/plain')
  })

  test('a non-2xx answer throws, names the status and carries it on the error', async () => {
    const base = await serve((request, response) => {
      const status = request.url === '/metrics' ? 401 : 503
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'warming' }))
    })

    const unauthorized = await fetchText(joinUrl(base, '/metrics')).then(
      () => undefined,
      (error) => error
    )
    assert.match(unauthorized.message, /answered 401/)
    assert.equal(unauthorized.status, 401, 'callers branch on the status, not on the message')

    const warming = await fetchJson(joinUrl(base, '/hot-scenes')).then(
      () => undefined,
      (error) => error
    )
    assert.match(warming.message, /answered 503/)
    assert.equal(warming.status, 503)
  })

  test('a bearer token is sent and never appears in the error', async () => {
    const seen = []
    const base = await serve((request, response) => {
      seen.push(request.headers.authorization)
      response.writeHead(401).end('unauthorized')
    })
    const env = { GATEKEEPER_METRICS_URL: `${base}/metrics`, GATEKEEPER_METRICS_TOKEN: TOKEN }

    const error = await fetchText(`${base}/metrics`, { headers: authHeaders(env, 'GATEKEEPER_METRICS_URL') }).then(
      () => undefined,
      (failure) => failure
    )

    assert.deepEqual(seen, [`Bearer ${TOKEN}`], 'the header reached the server')
    assert.match(error.message, /answered 401/)
    assert.doesNotMatch(error.message, new RegExp(TOKEN), 'a cron log must never carry the token')
    assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), new RegExp(TOKEN))
  })

  test('a slow endpoint times out with the URL and the budget in the message', async () => {
    const base = await serve(() => {
      // Never answers: the request hangs until the abort signal fires.
    })

    const error = await fetchText(`${base}/metrics`, { timeoutMs: 60 }).then(
      () => undefined,
      (failure) => failure
    )

    assert.match(error.message, /timed out after 60 ms/)
    assert.match(error.message, /\/metrics/)
  })

  test('credentials in the URL are redacted out of every message', async () => {
    const error = await fetchJson('https://user:hunter2@127.0.0.1:1/realms', { timeoutMs: 60 }).then(
      () => undefined,
      (failure) => failure
    )

    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /hunter2/)
    assert.match(error.message, /127\.0\.0\.1/)
  })
})

describe('http: bearer token resolution', () => {
  test('reads <BASE>_TOKEN, then <BASE>_BEARER_TOKEN, then the shared METRICS_BEARER_TOKEN', () => {
    assert.equal(bearerToken({ GATEKEEPER_METRICS_TOKEN: 'a' }, 'GATEKEEPER_METRICS_URL'), 'a')
    assert.equal(bearerToken({ GATEKEEPER_METRICS_BEARER_TOKEN: 'b' }, 'GATEKEEPER_METRICS_URL'), 'b')
    assert.equal(bearerToken({ METRICS_BEARER_TOKEN: 'shared' }, 'GATEKEEPER_METRICS_URL'), 'shared')
    assert.equal(bearerToken({ METRICS_BEARER_TOKEN: 'shared' }, 'WCS_URL'), 'shared')
    assert.equal(bearerToken({ WCS_TOKEN: 'own', METRICS_BEARER_TOKEN: 'shared' }, 'WCS_URL'), 'own')
  })

  test('an unset or blank token means no header at all', () => {
    assert.equal(bearerToken({}, 'PULSE_URL'), undefined)
    assert.equal(bearerToken({ PULSE_TOKEN: '   ' }, 'PULSE_URL'), undefined)
    assert.deepEqual(authHeaders({}, 'PULSE_URL'), {})
    assert.deepEqual(authHeaders({ PULSE_TOKEN: TOKEN }, 'PULSE_URL'), { authorization: `Bearer ${TOKEN}` })
  })
})

describe('http: joinUrl and requireEnv', () => {
  test('a trailing slash on the base does not double the separator', () => {
    assert.equal(joinUrl('https://a.example.com', '/live-data'), 'https://a.example.com/live-data')
    assert.equal(joinUrl('https://a.example.com/', '/live-data'), 'https://a.example.com/live-data')
    assert.equal(joinUrl('https://a.example.com///', '/live-data'), 'https://a.example.com/live-data')
  })

  test('requireEnv trims and rejects a missing or blank value', () => {
    assert.equal(requireEnv({ WCS_URL: '  https://a.example.com ' }, 'WCS_URL'), 'https://a.example.com')
    assert.throws(() => requireEnv({}, 'WCS_URL'), /WCS_URL is required/)
    assert.throws(() => requireEnv({ WCS_URL: '' }, 'WCS_URL'), /WCS_URL is required/)
  })
})
