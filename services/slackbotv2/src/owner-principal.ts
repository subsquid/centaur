import type { Logger } from 'chat'
import { fetchSlackUserProfile } from './session-api'
import type { SlackbotV2Options, SlackbotV2ThreadOwner } from './types'
import { isJsonObject, noopLogger, stringValue } from './utils'

/**
 * The personal principal a thread owner's session runs under, plus whether the
 * owner has registered a provider key. Mirrors the console resolve_slack response.
 */
export type OwnerPrincipal = {
  hasProviderKey: boolean
  principalForeignId: string
}

// Tighter than requesterIdentityCache's 6h/10min: a key change must take effect
// promptly. Transient failures are not cached at all (return without writing).
const SUCCESS_TTL_MS = 5 * 60 * 1000
const NEGATIVE_TTL_MS = 60 * 1000
const RESOLVE_TIMEOUT_MS = 2000

type CacheEntry = { expiresAtMs: number; value: OwnerPrincipal | null }
const cache = new Map<string, CacheEntry>()

export function clearOwnerPrincipalCacheForTests(): void {
  cache.clear()
}

/** Per-owner resolution is active only once the console URL + token are set. */
export function isOwnerPrincipalConfigured(options: SlackbotV2Options): boolean {
  return Boolean(options.consoleUrl && options.consoleToken)
}

/**
 * Resolve a thread owner to the personal principal their session should run as.
 *
 * Returns `null` when unconfigured, when the owner can't be mapped (no verified
 * Slack email, or no matching console user), or on a transient failure — callers
 * fail closed (skip + prompt onboarding) rather than run under a shared key.
 * Never throws into the Slack hot path; ~2s timeout; short-TTL cached. A
 * transient failure is deliberately NOT cached so a retry can succeed once the
 * dependency recovers.
 */
export async function resolveOwnerPrincipal(
  options: SlackbotV2Options,
  owner: SlackbotV2ThreadOwner
): Promise<OwnerPrincipal | null> {
  if (!isOwnerPrincipalConfigured(options)) return null

  const cacheKey = ownerCacheKey(owner)
  const cached = readCache(cacheKey)
  if (cached !== undefined) return cached

  const logger = options.logger ?? noopLogger
  try {
    const email = await fetchOwnerEmail(options, owner.slackUserId, logger)
    if (!email) {
      writeCache(cacheKey, null, NEGATIVE_TTL_MS)
      return null
    }
    const resolved = await fetchConsolePrincipal(options, email)
    if (resolved === undefined) return null // transient: do not cache
    writeCache(cacheKey, resolved, resolved ? SUCCESS_TTL_MS : NEGATIVE_TTL_MS)
    return resolved
  } catch (error) {
    logger.warn('slackbotv2_owner_principal_resolve_failed', {
      error: error instanceof Error ? error.message : String(error),
      owner_user_id: owner.slackUserId
    })
    return null
  }
}

/**
 * The owner's verified Slack email (needs the users:read.email scope). Shares
 * fetchSlackUserProfile so owner resolution inherits its config guards + the
 * merged users.info/users.profile.get result, with a ~2s budget so it can't
 * stall the hot path.
 */
async function fetchOwnerEmail(
  options: SlackbotV2Options,
  slackUserId: string,
  logger: Logger
): Promise<string | undefined> {
  const profile = await fetchSlackUserProfile(options, slackUserId, RESOLVE_TIMEOUT_MS)
  if (!profile) return undefined
  const email = stringValue(profile.email)
  if (!email) {
    // Profile loaded but no email: almost always the missing users:read.email
    // scope. Log distinctly so that misconfiguration is diagnosable (M3) rather
    // than silently failing closed like a transient fetch failure.
    logger.warn('slackbotv2_owner_email_absent', { owner_user_id: slackUserId })
  }
  return email
}

/**
 * GET console resolve_slack. Returns the principal on a hit, `null` when there is
 * no console user (404), and `undefined` on a transient failure so the caller
 * neither runs nor negative-caches it.
 */
async function fetchConsolePrincipal(
  options: SlackbotV2Options,
  email: string
): Promise<OwnerPrincipal | null | undefined> {
  const fetchFn = options.fetch ?? fetch
  const url = new URL('/api/v1/principals/resolve_slack', options.consoleUrl)
  url.searchParams.set('email', email)
  let response: Response
  try {
    response = await fetchFn(url, {
      headers: { authorization: `Bearer ${options.consoleToken}` },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    })
  } catch {
    return undefined
  }
  if (response.status === 404) return null
  if (!response.ok) return undefined
  const payload = await response.json().catch(() => undefined)
  const data = isJsonObject(payload) && isJsonObject(payload.data) ? payload.data : undefined
  const principalForeignId = data ? stringValue(data.principal_foreign_id) : undefined
  if (!principalForeignId) return undefined
  return { hasProviderKey: data?.has_provider_key === true, principalForeignId }
}

function ownerCacheKey(owner: SlackbotV2ThreadOwner): string {
  return owner.teamId ? `${owner.teamId}:${owner.slackUserId}` : owner.slackUserId
}

function readCache(key: string): OwnerPrincipal | null | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function writeCache(key: string, value: OwnerPrincipal | null, ttlMs: number): void {
  cache.set(key, { expiresAtMs: Date.now() + ttlMs, value })
}
