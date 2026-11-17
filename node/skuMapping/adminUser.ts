import { createHash } from 'crypto'

import { failureDetail, SkuMappingError } from './errors'

/** Answer of VTEX ID's POST /api/vtexid/credential/validate. */
export interface TokenValidation {
  authStatus?: string
  account?: string
  audience?: string
  user?: string
}

export interface AdminUser {
  /** Lower-case e-mail, stored as user_id of the imports this user opens. */
  email: string
}

export type ValidateToken = (token: string) => Promise<TokenValidation>

/**
 * The Admin user behind a request: its token (VtexIdclientAutCookie) must be
 * an Admin token of this account, confirmed by VTEX ID. A confirmed token is
 * kept for a minute, so the chunks of an import do not call VTEX ID each time.
 */
export function createAdminUsers({
  now = Date.now,
  ttlMs = 60000,
  maxEntries = 500,
}: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
  const confirmed = new Map<string, { user: AdminUser; until: number }>()

  return {
    async verify(
      account: string,
      token: string | undefined,
      validate: ValidateToken
    ): Promise<AdminUser> {
      if (!token) throw new SkuMappingError('UNAUTHORIZED')

      // Hashed, so the cache never holds a usable token.
      const key = createHash('sha256').update(`${account}\n${token}`).digest('hex')
      const cached = confirmed.get(key)

      if (cached && cached.until > now()) return cached.user
      confirmed.delete(key)

      let answer: TokenValidation

      try {
        answer = await validate(token)
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status

        if (status !== undefined && status >= 400 && status < 500) {
          throw new SkuMappingError('UNAUTHORIZED')
        }

        throw new SkuMappingError('UNAVAILABLE', {
          source: 'vtex-id',
          ...failureDetail(error),
        })
      }

      const email = typeof answer?.user === 'string' ? answer.user.trim().toLowerCase() : ''

      if (
        answer?.authStatus !== 'Success' ||
        answer.audience !== 'admin' ||
        answer.account !== account ||
        !email
      ) {
        throw new SkuMappingError('UNAUTHORIZED')
      }

      if (confirmed.size >= maxEntries) {
        const oldest = confirmed.keys().next()

        if (!oldest.done) confirmed.delete(oldest.value)
      }

      const user = { email }

      confirmed.set(key, { user, until: now() + ttlMs })

      return user
    },
  }
}
