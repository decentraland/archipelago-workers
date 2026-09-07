'use strict'

// Reading two Redis sets without a Redis client library. Two routes, both dependency-free:
//   * `redis-cli` over a child process when the operator has it on PATH (the usual case on a
//     bastion), password handed over in `REDISCLI_AUTH` so it never reaches the process list;
//   * otherwise a minimal RESP client over `net`/`tls` -- enough for AUTH, SELECT and SMEMBERS.
//
// Set members are wallet addresses. Nothing here logs, prints or returns them beyond the array the
// caller reduces to counts; error messages are built from the reply text with the URL's credentials
// stripped.

const net = require('node:net')
const tls = require('node:tls')
const { spawn } = require('node:child_process')

const DEFAULT_PORT = 6379
const DEFAULT_TIMEOUT_MS = 10000

const decode = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const parseRedisUrl = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('REDIS_URL is required')
  }
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Error(`REDIS_URL must be a redis:// or rediss:// URL, got "${raw}"`)
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must be a redis:// or rediss:// URL, got "${url.protocol}"`)
  }
  const db = url.pathname.replace(/^\//, '')
  return {
    host: url.hostname,
    port: url.port === '' ? DEFAULT_PORT : Number(url.port),
    password: url.password === '' ? undefined : decode(url.password),
    username: url.username === '' ? undefined : decode(url.username),
    db: db === '' ? undefined : Number(db),
    tls: url.protocol === 'rediss:'
  }
}

// Never let a password reach a log line or an error message.
const redactUrl = (raw) => String(raw ?? '').replace(/(redis[s]?:\/\/)[^@/]*@/i, '$1<redacted>@')

const encodeCommand = (args) => {
  let out = `*${args.length}\r\n`
  for (const arg of args) {
    const text = String(arg)
    out += `$${Buffer.byteLength(text, 'utf8')}\r\n${text}\r\n`
  }
  return out
}

const CRLF = 2

const indexOfCrlf = (buffer, from) => {
  const at = buffer.indexOf('\r\n', from, 'utf8')
  return at === -1 ? -1 : at
}

// Returns { value, consumed }, or null while the reply is still incomplete. Throws on an error
// reply and on an unknown type byte.
const parseReply = (buffer, start = 0) => {
  if (buffer.length <= start) {
    return null
  }
  const type = String.fromCharCode(buffer[start])
  const lineEnd = indexOfCrlf(buffer, start)
  if (lineEnd === -1) {
    return null
  }
  const header = buffer.toString('utf8', start + 1, lineEnd)

  if (type === '+') {
    return { value: header, consumed: lineEnd + CRLF - start }
  }
  if (type === '-') {
    throw new Error(header)
  }
  if (type === ':') {
    return { value: Number(header), consumed: lineEnd + CRLF - start }
  }
  if (type === '$') {
    const length = Number(header)
    if (length === -1) {
      return { value: null, consumed: lineEnd + CRLF - start }
    }
    const bodyStart = lineEnd + CRLF
    if (buffer.length < bodyStart + length + CRLF) {
      return null
    }
    return {
      value: buffer.toString('utf8', bodyStart, bodyStart + length),
      consumed: bodyStart + length + CRLF - start
    }
  }
  if (type === '*') {
    const count = Number(header)
    if (count === -1) {
      return { value: null, consumed: lineEnd + CRLF - start }
    }
    const value = []
    let offset = lineEnd + CRLF
    for (let i = 0; i < count; i += 1) {
      const element = parseReply(buffer, offset)
      if (element === null) {
        return null
      }
      value.push(element.value)
      offset += element.consumed
    }
    return { value, consumed: offset - start }
  }
  throw new Error(`unsupported RESP type byte "${type}"`)
}

// redis-cli exits 0 and prints the error text for a failed command, so the text is what we check.
const CLI_ERROR = /^(?:\(error\)\s*)?(ERR|WRONGTYPE|NOAUTH|NOPERM|WRONGPASS|MOVED|ASK|CLUSTERDOWN|LOADING|BUSY|BUSYGROUP|EXECABORT|MASTERDOWN|READONLY|NOSCRIPT|NOTBUSY|UNBLOCKED|OOM|MISCONF|NOPROTO|TRYAGAIN|CROSSSLOT)\b/

const parseRedisCliLines = (text) => {
  const members = []
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line === '') {
      continue
    }
    if (CLI_ERROR.test(line)) {
      throw new Error(line)
    }
    members.push(line)
  }
  return members
}

const cliArgs = (parsed, key) => {
  const args = ['-h', parsed.host, '-p', String(parsed.port), '--no-auth-warning']
  if (parsed.tls) {
    args.push('--tls')
  }
  if (parsed.username !== undefined) {
    args.push('--user', parsed.username)
  }
  if (parsed.db !== undefined) {
    args.push('-n', String(parsed.db))
  }
  args.push('smembers', key)
  return args
}

// The password travels in REDISCLI_AUTH, not in argv: argv is world-readable in /proc.
const readSetViaCli = (url, key, options = {}) => {
  const parsed = parseRedisUrl(url)
  const spawnFn = options.spawn ?? spawn
  const bin = options.redisCli ?? 'redis-cli'
  return new Promise((resolve, reject) => {
    const env = { ...(options.env ?? process.env) }
    if (parsed.password !== undefined) {
      env.REDISCLI_AUTH = parsed.password
    }
    const child = spawnFn(bin, cliArgs(parsed, key), { env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => reject(new Error(`redis-cli failed: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`redis-cli exited ${code}: ${stderr.trim() || 'no output'}`))
        return
      }
      try {
        resolve(parseRedisCliLines(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}

const connectSocket = (parsed) =>
  parsed.tls
    ? tls.connect({ host: parsed.host, port: parsed.port, servername: parsed.host })
    : net.connect({ host: parsed.host, port: parsed.port })

const readSetViaResp = (url, key, options = {}) => {
  const parsed = parseRedisUrl(url)
  const connect = options.connect ?? connectSocket
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const commands = []
  if (parsed.password !== undefined) {
    commands.push(parsed.username === undefined ? ['AUTH', parsed.password] : ['AUTH', parsed.username, parsed.password])
  }
  if (parsed.db !== undefined) {
    commands.push(['SELECT', String(parsed.db)])
  }
  commands.push(['SMEMBERS', key])

  return new Promise((resolve, reject) => {
    const socket = connect(parsed)
    let buffer = Buffer.alloc(0)
    let pending = commands.length
    let settled = false
    const replies = []

    const finish = (error, value) => {
      if (settled) {
        return
      }
      settled = true
      try {
        socket.end()
        socket.destroy()
      } catch {
        // the socket is already gone; nothing to clean up
      }
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }

    socket.setTimeout?.(timeoutMs, () => finish(new Error(`redis read timed out after ${timeoutMs} ms`)))
    socket.on('error', (error) => finish(new Error(`redis read failed: ${error.message}`)))
    socket.on('close', () => finish(new Error('redis closed the connection before answering')))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      try {
        for (;;) {
          const reply = parseReply(buffer, 0)
          if (reply === null) {
            return
          }
          buffer = buffer.subarray(reply.consumed)
          replies.push(reply.value)
          pending -= 1
          if (pending === 0) {
            const members = replies[replies.length - 1]
            if (!Array.isArray(members)) {
              finish(new Error(`SMEMBERS did not answer an array for the configured key`))
              return
            }
            finish(null, members)
            return
          }
        }
      } catch (error) {
        finish(error)
      }
    })
    socket.on('connect', () => {
      socket.write(commands.map(encodeCommand).join(''))
    })
    if (parsed.tls) {
      socket.on('secureConnect', () => socket.write(commands.map(encodeCommand).join('')))
    }
  })
}

// `redis-cli` first when it is installed, the built-in RESP client otherwise.
const hasRedisCli = (options = {}) =>
  new Promise((resolve) => {
    const spawnFn = options.spawn ?? spawn
    try {
      const child = spawnFn(options.redisCli ?? 'redis-cli', ['--version'], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })

const readSet = async (url, key, options = {}) => {
  const useCli = options.useCli ?? (await hasRedisCli(options))
  try {
    return useCli ? await readSetViaCli(url, key, options) : await readSetViaResp(url, key, options)
  } catch (error) {
    // Re-raise with the URL redacted so a cron log never carries the Redis password.
    throw new Error(`reading ${key} from ${redactUrl(url)} failed: ${error.message}`)
  }
}

module.exports = {
  DEFAULT_PORT,
  cliArgs,
  encodeCommand,
  hasRedisCli,
  parseRedisCliLines,
  parseRedisUrl,
  parseReply,
  readSet,
  readSetViaCli,
  readSetViaResp,
  redactUrl
}
