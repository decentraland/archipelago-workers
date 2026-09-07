'use strict'

const assert = require('node:assert/strict')
const { test, describe } = require('node:test')

const { encodeCommand, parseRedisUrl, parseReply, parseRedisCliLines } = require('../src/redis')

describe('redis url parsing', () => {
  test('reads host and port', () => {
    assert.deepEqual(parseRedisUrl('redis://redis.example.com:6380'), {
      host: 'redis.example.com',
      port: 6380,
      password: undefined,
      username: undefined,
      db: undefined,
      tls: false
    })
  })

  test('defaults the port to 6379', () => {
    assert.equal(parseRedisUrl('redis://redis.example.com').port, 6379)
  })

  test('reads the password without putting it in the returned string form', () => {
    const parsed = parseRedisUrl('redis://:s3cret@redis.example.com:6379/2')
    assert.equal(parsed.password, 's3cret')
    assert.equal(parsed.db, 2)
    assert.equal(parsed.host, 'redis.example.com')
  })

  test('reads a username as well, and percent-decodes both', () => {
    const parsed = parseRedisUrl('redis://user%40x:p%3Ass@redis.example.com:6379')
    assert.equal(parsed.username, 'user@x')
    assert.equal(parsed.password, 'p:ss')
  })

  test('rediss:// asks for TLS', () => {
    assert.equal(parseRedisUrl('rediss://redis.example.com:6379').tls, true)
  })

  test('rejects a URL that is not redis', () => {
    assert.throws(() => parseRedisUrl('http://redis.example.com'), /redis/i)
    assert.throws(() => parseRedisUrl(''), /REDIS_URL/)
  })
})

describe('RESP encoding', () => {
  test('encodes a command as an array of bulk strings', () => {
    assert.equal(encodeCommand(['SMEMBERS', 'peers:online']), '*2\r\n$8\r\nSMEMBERS\r\n$12\r\npeers:online\r\n')
  })

  test('measures the bulk length in bytes, not characters', () => {
    assert.equal(encodeCommand(['GET', 'ké']), '*2\r\n$3\r\nGET\r\n$3\r\nké\r\n')
  })
})

describe('RESP reply parsing', () => {
  const parse = (text) => parseReply(Buffer.from(text, 'utf8'))

  test('parses a simple string', () => {
    assert.deepEqual(parse('+OK\r\n'), { value: 'OK', consumed: 5 })
  })

  test('parses an integer', () => {
    assert.deepEqual(parse(':42\r\n'), { value: 42, consumed: 5 })
  })

  test('parses a bulk string', () => {
    assert.deepEqual(parse('$3\r\nabc\r\n'), { value: 'abc', consumed: 9 })
  })

  test('parses a null bulk string', () => {
    assert.deepEqual(parse('$-1\r\n'), { value: null, consumed: 5 })
  })

  test('parses an array of bulk strings, which is what SMEMBERS answers', () => {
    const reply = parse('*2\r\n$4\r\n0xaa\r\n$4\r\n0xbb\r\n')
    assert.deepEqual(reply.value, ['0xaa', '0xbb'])
    assert.equal(reply.consumed, 24)
  })

  test('parses an empty array', () => {
    assert.deepEqual(parse('*0\r\n'), { value: [], consumed: 4 })
  })

  test('returns null while the reply is still incomplete', () => {
    assert.equal(parse('*2\r\n$4\r\n0xaa\r\n'), null)
    assert.equal(parse('$4\r\n0xa'), null)
    assert.equal(parse('+OK'), null)
    assert.equal(parse(''), null)
  })

  test('turns an error reply into a thrown error', () => {
    assert.throws(() => parse('-WRONGTYPE not a set\r\n'), /WRONGTYPE not a set/)
  })

  test('rejects an unknown type byte rather than guessing', () => {
    assert.throws(() => parse('?nope\r\n'), /RESP/)
  })
})

describe('redis-cli output parsing', () => {
  test('one member per line, blank lines dropped', () => {
    assert.deepEqual(parseRedisCliLines('0xaa\n0xbb\n\n'), ['0xaa', '0xbb'])
  })

  test('an empty set is an empty array', () => {
    assert.deepEqual(parseRedisCliLines(''), [])
    assert.deepEqual(parseRedisCliLines('\n'), [])
  })

  test('CRLF output is handled', () => {
    assert.deepEqual(parseRedisCliLines('0xaa\r\n0xbb\r\n'), ['0xaa', '0xbb'])
  })

  test('an error line from redis-cli is raised, not returned as a member', () => {
    assert.throws(() => parseRedisCliLines('WRONGTYPE Operation against a key holding the wrong kind of value\n'), /WRONGTYPE/)
    assert.throws(() => parseRedisCliLines('ERR unknown command\n'), /ERR/)
  })
})
