import { getErrorMessage } from '../../src/logic/errors'

describe('getErrorMessage', () => {
  describe('when given an Error', () => {
    it('should return its message', () => {
      expect(getErrorMessage(new Error('boom'))).toBe('boom')
    })
  })

  describe('when given a plain object carrying a message', () => {
    it('should return it, since not every thrown value is an Error', () => {
      expect(getErrorMessage({ message: 'from a rejected promise' })).toBe('from a rejected promise')
    })
  })

  describe('when given a value with no message', () => {
    it.each([
      ['a string', 'just a string'],
      ['a number', 42],
      ['null', null],
      ['undefined', undefined],
      ['an object without message', { code: 'ENOENT' }]
    ])('should fall back to Unknown error for %s', (_label, value) => {
      expect(getErrorMessage(value)).toBe('Unknown error')
    })
  })
})
