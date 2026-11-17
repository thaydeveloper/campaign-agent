/**
 * Codes the screen translates. Each failure the user can act on has one; the
 * GraphQL error message is the code itself.
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

export type ErrorCode = typeof ERROR_CODES[number]

/** Codes the database functions raise (SQLSTATE P0001, message = code). */
const DATABASE_CODES: readonly ErrorCode[] = [
  'INVALID_INPUT',
  'INVALID_ROWS',
  'IMPORT_RUNNING',
  'IMPORT_NOT_RUNNING',
]

export class SkuMappingError extends Error {
  /**
   * `detail` goes to the log only, never to the screen. It must not carry
   * tokens or request headers.
   */
  constructor(
    public readonly code: ErrorCode,
    public readonly detail?: Record<string, unknown>
  ) {
    super(code)
    this.name = 'SkuMappingError'
  }
}

type HttpFailure = {
  response?: { status?: number; data?: unknown }
  code?: unknown
  message?: unknown
}

/** HTTP status and body of a failed upstream call, safe to log. */
export function failureDetail(error: unknown): Record<string, unknown> {
  const failure = (error ?? {}) as HttpFailure
  const data = failure.response?.data
  const body =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : { body: typeof data === 'string' ? data.slice(0, 300) : undefined }

  return {
    status: failure.response?.status,
    code: body.code ?? (typeof failure.code === 'string' ? failure.code : undefined),
    message:
      typeof body.message === 'string'
        ? body.message.slice(0, 300)
        : typeof failure.message === 'string'
        ? failure.message.slice(0, 300)
        : undefined,
    hint: typeof body.hint === 'string' ? body.hint.slice(0, 300) : undefined,
  }
}

/**
 * Turns a Supabase Data API failure into a code. Expected failures come back
 * as HTTP 400 with `{ code: "P0001", message: "<CODE>" }`; anything else
 * (network, expired token, missing function) is UNAVAILABLE.
 */
export function databaseError(error: unknown): SkuMappingError {
  if (error instanceof SkuMappingError) return error
  const detail = failureDetail(error)
  const code = DATABASE_CODES.find((known) => known === detail.message)

  if (detail.code === 'P0001' && code) return new SkuMappingError(code)

  return new SkuMappingError('UNAVAILABLE', { source: 'database', ...detail })
}
