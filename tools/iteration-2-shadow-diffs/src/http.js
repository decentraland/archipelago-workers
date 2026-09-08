'use strict'

// The harness only ever GETs. `fetch` is built in on Node >= 20, so there is nothing to install.
//
// Every scraped or fetched URL can carry an `Authorization: Bearer` header, because the endpoints
// are not all anonymous: `@dcl/http-server`'s `/metrics` route answers 401 unless the request
// matches its configured bearer token, and the contract pack records that as the deployed
// convention (`docs/contracts/iteration-2/http/redirects.json`). Without a header, diff 1 would
// collect nothing at all in an environment where that token is set, with no configuration that
// could fix it.
//
// The token itself never reaches a log line: it lives only in a request header, and every error
// message carries a URL with its userinfo stripped.

const DEFAULT_TIMEOUT_MS = 15000

// One token for every endpoint, for the common case where the operator holds a single scrape
// credential. A per-endpoint variable wins over it.
const SHARED_TOKEN_VAR = 'METRICS_BEARER_TOKEN'

const requireEnv = (env, name) => {
  const value = env[name]
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${name} is required`)
  }
  return String(value).trim()
}

// `https://host/` + `/live-data` must not become `https://host//live-data`.
const joinUrl = (base, path) => `${String(base).replace(/\/+$/, '')}${path}`

// Strips `user:password@` out of every URL-looking substring of a message. `fetch` itself refuses a
// URL that carries credentials and quotes the whole URL back in the rejection, so the underlying
// message needs the same treatment as the URL we print ourselves.
const scrub = (text) => String(text ?? '').replace(/\/\/[^\s/@]*@/g, '//')

// A URL is safe to print only once any `user:password@` in it is gone.
const redactUrl = (url) => {
  const text = String(url)
  try {
    const parsed = new URL(text)
    if (parsed.username === '' && parsed.password === '') {
      return text
    }
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return text.replace(/\/\/[^/@]*@/, '//')
  }
}

// `GATEKEEPER_METRICS_URL` -> `GATEKEEPER_METRICS_TOKEN`, `GATEKEEPER_METRICS_BEARER_TOKEN`, then
// the shared variable. The same pattern gives `WCS_TOKEN`, `PULSE_TOKEN`, `STATS_TOKEN`,
// `GATEKEEPER_TOKEN`, so a new endpoint needs no code here.
const tokenVarsFor = (urlVarName) => {
  const base = String(urlVarName).replace(/_URL$/, '')
  return [`${base}_TOKEN`, `${base}_BEARER_TOKEN`, SHARED_TOKEN_VAR]
}

const bearerToken = (env = {}, urlVarName) => {
  for (const name of tokenVarsFor(urlVarName)) {
    const raw = env[name]
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      return String(raw).trim()
    }
  }
  return undefined
}

// `{}` when there is no token: an absent header is what an unauthenticated endpoint expects.
const authHeaders = (env = {}, urlVarName) => {
  const token = bearerToken(env, urlVarName)
  return token === undefined ? {} : { authorization: `Bearer ${token}` }
}

const get = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) => {
  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const timedOut = [error?.name, error?.cause?.name].includes('TimeoutError') || error?.name === 'AbortError'
    if (timedOut) {
      throw new Error(`GET ${redactUrl(url)} timed out after ${timeoutMs} ms`, { cause: error })
    }
    throw new Error(`GET ${redactUrl(url)} failed: ${scrub(error?.message ?? error)}`, { cause: error })
  }
  if (!response.ok) {
    // `status` on the error, not only in the message: a caller that treats one status as data
    // rather than as a failure (gatekeeper's `503 warming`) must not have to parse prose.
    const failure = new Error(`GET ${redactUrl(url)} answered ${response.status}`)
    failure.status = response.status
    throw failure
  }
  return response
}

const fetchJson = async (url, options) => (await get(url, options)).json()

// `accept: text/plain` for a Prometheus page, without dropping any header the caller passed.
const fetchText = async (url, options = {}) =>
  (await get(url, { ...options, headers: { accept: 'text/plain', ...options.headers } })).text()

module.exports = {
  DEFAULT_TIMEOUT_MS,
  SHARED_TOKEN_VAR,
  authHeaders,
  bearerToken,
  fetchJson,
  fetchText,
  joinUrl,
  redactUrl,
  scrub,
  requireEnv,
  tokenVarsFor
}
