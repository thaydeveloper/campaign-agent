/**
 * The Node service answers expected failures with the code as the GraphQL
 * error message (see graphql/schema.graphql). The screen shows each code with
 * its own translated message.
 */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'NOT_CONFIGURED',
  'ORGANIZATION_NOT_FOUND',
  'INVALID_INPUT',
  'INVALID_ROWS',
  'IMPORT_RUNNING',
  'IMPORT_NOT_RUNNING',
  'UNAVAILABLE',
] as const

/** NETWORK: the request got no GraphQL answer at all. */
export type ErrorCode = typeof ERROR_CODES[number] | 'NETWORK'

interface ApolloLikeError {
  graphQLErrors?: ReadonlyArray<{ message?: unknown }>
}

export function errorCode(error: unknown): ErrorCode {
  const graphQLErrors = (error as ApolloLikeError | undefined)?.graphQLErrors ?? []

  for (const item of graphQLErrors) {
    const message = typeof item?.message === 'string' ? item.message : ''
    const code = ERROR_CODES.find((known) => new RegExp(`\\b${known}\\b`).test(message))

    if (code) return code
  }

  return graphQLErrors.length ? 'UNAVAILABLE' : 'NETWORK'
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * For requests that are safe to send again (import chunks): retried after a
 * lost connection or an upstream failure, up to three times.
 */
export async function withRetries<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      const code = errorCode(error)

      if (attempt >= attempts || (code !== 'NETWORK' && code !== 'UNAVAILABLE')) throw error
      await wait(attempt * 1000)
    }
  }
}
