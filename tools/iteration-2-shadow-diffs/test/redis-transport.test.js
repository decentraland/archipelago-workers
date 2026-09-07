'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test, describe } = require('node:test')

const { readSet, readSetViaCli, readSetViaResp } = require('../src/redis')

const URL_WITH_PASSWORD = 'redis://:s3cret@redis.example.com:6380/2'

// A stand-in for a child process: stdout/stderr streams plus the close event.
const fakeSpawn = ({ stdout = '', stderr = '', code = 0, failWith } = {}) => {
  const calls = []
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, env: options && options.env })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = () => {}
    setImmediate(() => {
      if (failWith) {
        child.emit('error', new Error(failWith))
        return
      }
      if (stdout) {
        child.stdout.emit('data', stdout)
      }
      if (stderr) {
        child.stderr.emit('data', stderr)
      }
      child.emit('close', code)
    })
    return child
  }
  return { calls, spawn }
}

// A stand-in for a socket: records what was written, answers with the given RESP frames.
const fakeSocket = (replies) => {
  const written = []
  const connect = () => {
    const socket = new EventEmitter()
    socket.setTimeout = () => {}
    socket.end = () => {}
    socket.destroy = () => {}
    socket.write = (text) => {
      written.push(text)
      setImmediate(() => socket.emit('data', Buffer.from(replies, 'utf8')))
      return true
    }
    setImmediate(() => socket.emit('connect'))
    return socket
  }
  return { written, connect }
}

describe('reading a set through redis-cli', () => {
  test('addresses the configured host, port and db and asks for the members', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: '0xaa\n0xbb\n' })
    const members = await readSetViaCli(URL_WITH_PASSWORD, 'peers:online', { spawn, env: {} })

    assert.deepEqual(members, ['0xaa', '0xbb'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].bin, 'redis-cli')
    assert.deepEqual(calls[0].args, [
      '-h',
      'redis.example.com',
      '-p',
      '6380',
      '--no-auth-warning',
      '-n',
      '2',
      'smembers',
      'peers:online'
    ])
  })

  test('the password travels in the environment, never in argv', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: '' })
    await readSetViaCli(URL_WITH_PASSWORD, 'peers:online', { spawn, env: {} })

    assert.equal(calls[0].env.REDISCLI_AUTH, 's3cret')
    assert.doesNotMatch(calls[0].args.join(' '), /s3cret/)
  })

  test('rediss:// asks redis-cli for TLS', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: '' })
    await readSetViaCli('rediss://redis.example.com', 'peers:online', { spawn, env: {} })
    assert.ok(calls[0].args.includes('--tls'))
  })

  test('an error line is raised rather than counted as a member', async () => {
    const { spawn } = fakeSpawn({ stdout: 'WRONGTYPE Operation against a key holding the wrong kind of value\n' })
    await assert.rejects(() => readSetViaCli(URL_WITH_PASSWORD, 'peers:online', { spawn, env: {} }), /WRONGTYPE/)
  })

  test('a non-zero exit is raised', async () => {
    const { spawn } = fakeSpawn({ stderr: 'Could not connect', code: 1 })
    await assert.rejects(() => readSetViaCli(URL_WITH_PASSWORD, 'peers:online', { spawn, env: {} }), /exited 1/)
  })
})

describe('reading a set through the built-in RESP client', () => {
  test('authenticates, selects the db and asks for the members', async () => {
    const { written, connect } = fakeSocket('+OK\r\n+OK\r\n*2\r\n$4\r\n0xaa\r\n$4\r\n0xbb\r\n')
    const members = await readSetViaResp(URL_WITH_PASSWORD, 'peers:online', { connect })

    assert.deepEqual(members, ['0xaa', '0xbb'])
    const sent = written.join('')
    assert.ok(sent.includes('AUTH'), 'sent AUTH')
    assert.ok(sent.includes('SELECT'), 'sent SELECT')
    assert.ok(sent.includes('SMEMBERS'), 'sent SMEMBERS')
    assert.ok(sent.includes('peers:online'), 'named the key')
  })

  test('a URL without credentials sends only SMEMBERS', async () => {
    const { written, connect } = fakeSocket('*0\r\n')
    const members = await readSetViaResp('redis://redis.example.com', 'peers:online', { connect })

    assert.deepEqual(members, [])
    assert.equal(written.join('').includes('AUTH'), false)
    assert.equal(written.join('').includes('SELECT'), false)
  })

  test('an error reply is raised', async () => {
    const { connect } = fakeSocket('-WRONGTYPE not a set\r\n')
    await assert.rejects(() => readSetViaResp('redis://redis.example.com', 'peers:online', { connect }), /WRONGTYPE/)
  })
})

describe('readSet', () => {
  test('takes the redis-cli route when asked to', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: '0xaa\n' })
    const members = await readSet(URL_WITH_PASSWORD, 'peers:online', { useCli: true, spawn, env: {} })
    assert.deepEqual(members, ['0xaa'])
    assert.equal(calls.length, 1)
  })

  test('takes the RESP route when redis-cli is not available', async () => {
    const { connect } = fakeSocket('+OK\r\n+OK\r\n*1\r\n$4\r\n0xaa\r\n')
    const members = await readSet(URL_WITH_PASSWORD, 'peers:online', { useCli: false, connect })
    assert.deepEqual(members, ['0xaa'])
  })

  test('a failure names the key but never the password', async () => {
    const { connect } = fakeSocket('-WRONGTYPE not a set\r\n')
    await assert.rejects(
      () => readSet(URL_WITH_PASSWORD, 'peers:online', { useCli: false, connect }),
      (error) => {
        assert.match(error.message, /peers:online/)
        assert.match(error.message, /WRONGTYPE/)
        assert.doesNotMatch(error.message, /s3cret/)
        assert.match(error.message, /redacted/)
        return true
      }
    )
  })
})
