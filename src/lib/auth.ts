import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { db } from '#/db'
import * as schema from '#/db/schema'

const configuredSecret = process.env.BETTER_AUTH_SECRET?.trim()
if (!configuredSecret) {
  throw new Error('BETTER_AUTH_SECRET is required')
}

const configuredBaseUrl =
  process.env.BETTER_AUTH_BASE_URL?.trim() ?? process.env.BETTER_AUTH_URL?.trim()
const configuredTrustedOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const trustedOrigins = Array.from(
  new Set([configuredBaseUrl, ...(configuredTrustedOrigins ?? [])].filter(Boolean)),
)

export const auth = betterAuth({
  secret: configuredSecret,
  baseURL: configuredBaseUrl,
  trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    // Required behind load balancers/reverse proxies so Better Auth sees the real host/protocol.
    trustedProxyHeaders: true,
  },
  plugins: [tanstackStartCookies()],
})
