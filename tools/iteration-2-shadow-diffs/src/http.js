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

// The fallback token for a `/metrics` page — and, by default, for nothing else. A credential is not
// a configuration convenience: three of the five endpoints the harness reads (`/live-data`,
// `/realms`, `/hot-scenes`) are unauthenticated and public, and attaching gatekeeper's metrics
// bearer token to them would spread the one credential the operator holds to three services that
// never asked for it, plus whatever CDN and access logs sit in front of them.
const SHARED_TOKEN_VAR = 'METRICS_BEARER_TOKEN'
// ... unless the operator says so explicitly, for a deployment where one token really does open
// every endpoint. Opt-in, so the spread is a decision that is written down in the env file.
const SHARED_TOKEN_OPT_IN_VAR = 'SHADOW_SHARED_BEARER_TOKEN'
// `GATEKEEPER_METRICS_URL` — a variable that names a metrics page is what `METRICS_BEARER_TOKEN`
// is for, so the shared variable reaches those without the opt-in.
const METRICS_URL_VAR = /(^|_)METRICS_URL$/

const optedIn = (env) =>
  ['1', 'true', 'yes', 'on'].includes(
    String(env[SHARED_TOKEN_OPT_IN_VAR] ?? '')
      .trim()
      .toLowerCase()
  )

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

// `GATEKEEPER_METRICS_URL` -> `GATEKEEPER_METRICS_TOKEN`, `GATEKEEPER_METRICS_BEARER_TOKEN`. The
// same pattern gives `WCS_TOKEN`, `PULSE_TOKEN`, `STATS_TOKEN`, `GATEKEEPER_TOKEN`, so a new
// endpoint needs no code here. The shared `METRICS_BEARER_TOKEN` is appended only for a metrics
// page, or for every endpoint once `SHADOW_SHARED_BEARER_TOKEN` opts in.
const tokenVarsFor = (urlVarName, env = {}) => {
  const base = String(urlVarName).replace(/_URL$/, '')
  const names = [`${base}_TOKEN`, `${base}_BEARER_TOKEN`]
  if (METRICS_URL_VAR.test(String(urlVarName)) || optedIn(env)) {
    names.push(SHARED_TOKEN_VAR)
  }
  return names
}

const bearerToken = (env = {}, urlVarName) => {
  for (const name of tokenVarsFor(urlVarName, env)) {
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
  SHARED_TOKEN_OPT_IN_VAR,
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
