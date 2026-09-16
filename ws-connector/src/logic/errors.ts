/**
 * Narrows an unknown caught value to a loggable message.
 *
 * Exists so callers can write `catch (error)` instead of `catch (error: any)`, which switches the
 * type checker off at exactly the point it is most useful.
 *
 * @param error - The value caught in a `catch` block.
 * @returns The error's `message` when it has one, `'Unknown error'` otherwise.
 */
export function getErrorMessage(error: unknown): string {
  if (error !== undefined && error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }

  return 'Unknown error'
}
