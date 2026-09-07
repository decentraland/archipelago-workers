'use strict'

// The harness only ever GETs. `fetch` is built in on Node >= 20, so there is nothing to install.

const DEFAULT_TIMEOUT_MS = 15000

const requireEnv = (env, name) => {
  const value = env[name]
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${name} is required`)
  }
  return String(value).trim()
}

// `https://host/` + `/live-data` must not become `https://host//live-data`.
const joinUrl = (base, path) => `${String(base).replace(/\/+$/, '')}${path}`

const get = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`)
  }
  return response
}

const fetchJson = async (url, options) => (await get(url, options)).json()

const fetchText = async (url, options) =>
  (
    await get(url, { headers: { accept: 'text/plain' }, ...options })
  ).text()

module.exports = { DEFAULT_TIMEOUT_MS, fetchJson, fetchText, joinUrl, requireEnv }
