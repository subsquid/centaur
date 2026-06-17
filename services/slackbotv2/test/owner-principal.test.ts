import { beforeEach, describe, expect, test } from 'bun:test'
import type { Logger } from 'chat'
import {
  clearOwnerPrincipalCacheForTests,
  isOwnerPrincipalConfigured,
  resolveOwnerPrincipal
} from '../src/owner-principal'
import type { SlackbotV2Options, SlackbotV2ThreadOwner } from '../src/types'

const OWNER: SlackbotV2ThreadOwner = { slackUserId: 'U1', teamId: 'T1' }

type StubConfig = {
  consoleStatus?: number
  email?: string | null
  hasProviderKey?: boolean
  principalForeignId?: string | null
}

function stubFetch(config: StubConfig = {}) {
  const calls: string[] = []
  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    // resolveOwnerPrincipal reads the email via the shared fetchSlackUserProfile
    // helper, which merges users.info + users.profile.get. With the
    // users:read.email scope the email rides users.profile.get; mirror it on
    // both so the merged profile carries it (and carries none when absent).
    const email = config.email === undefined ? 'owner@example.com' : config.email
    if (url.includes('users.info')) {
      return Response.json({ ok: true, user: { profile: email ? { email } : {} } })
    }
    if (url.includes('users.profile.get')) {
      return Response.json({ ok: true, profile: email ? { email } : {} })
    }
    if (url.includes('resolve_slack')) {
      const status = config.consoleStatus ?? 200
      if (status !== 200) return new globalThis.Response('err', { status })
      const pfid = config.principalForeignId === undefined ? 'user-42' : config.principalForeignId
      return Response.json({
        data: {
          has_provider_key: config.hasProviderKey ?? true,
          principal_foreign_id: pfid,
          user_id: 'usr_x'
        }
      })
    }
    return Response.json({ ok: false }, { status: 404 })
  }
  return { calls, fetchFn }
}

function options(
  fetchFn: SlackbotV2Options['fetch'],
  overrides: Partial<SlackbotV2Options> = {}
): SlackbotV2Options {
  return {
    apiUrl: 'http://api.test',
    botToken: 'xoxb-test',
    consoleToken: 'iak_test',
    consoleUrl: 'http://console.test',
    fetch: fetchFn,
    signingSecret: 'secret',
    slackApiUrl: 'http://slack.test/api/',
    ...overrides
  }
}

function captureLogger(warnings: Array<{ event: string; data?: unknown }>): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (event: string, data?: unknown) => warnings.push({ event, data }),
    error: () => undefined,
    child: () => logger
  }
  return logger
}

describe('resolveOwnerPrincipal', () => {
  beforeEach(() => clearOwnerPrincipalCacheForTests())

  test('is a no-op (no network) when console is unconfigured', async () => {
    const { calls, fetchFn } = stubFetch()
    const unconfigured = options(fetchFn, { consoleToken: undefined, consoleUrl: undefined })
    expect(isOwnerPrincipalConfigured(unconfigured)).toBe(false)
    expect(await resolveOwnerPrincipal(unconfigured, OWNER)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('resolves owner email -> principal with a provider key', async () => {
    const { fetchFn } = stubFetch({ hasProviderKey: true, principalForeignId: 'user-42' })
    expect(await resolveOwnerPrincipal(options(fetchFn), OWNER)).toEqual({
      hasProviderKey: true,
      principalForeignId: 'user-42'
    })
  })

  test('reports has_provider_key: false (owner registered no key)', async () => {
    const { fetchFn } = stubFetch({ hasProviderKey: false })
    expect(await resolveOwnerPrincipal(options(fetchFn), OWNER)).toEqual({
      hasProviderKey: false,
      principalForeignId: 'user-42'
    })
  })

  test('returns null when the owner has no verified Slack email', async () => {
    const { fetchFn } = stubFetch({ email: null })
    expect(await resolveOwnerPrincipal(options(fetchFn), OWNER)).toBeNull()
  })

  test('fails closed and logs a distinct diagnostic when the profile has no email', async () => {
    // The Slack profile loads but carries no email -- the missing
    // users:read.email scope (M3). Must fail closed AND fire a distinct log so
    // the misconfiguration is diagnosable rather than looking like a transient
    // fetch failure.
    const { fetchFn } = stubFetch({ email: null })
    const warnings: Array<{ event: string; data?: unknown }> = []
    const logger = captureLogger(warnings)
    expect(await resolveOwnerPrincipal(options(fetchFn, { logger }), OWNER)).toBeNull()
    expect(warnings.map(entry => entry.event)).toContain('slackbotv2_owner_email_absent')
    const absent = warnings.find(entry => entry.event === 'slackbotv2_owner_email_absent')
    expect(absent?.data).toEqual(expect.objectContaining({ owner_user_id: OWNER.slackUserId }))
  })

  test('returns null when console has no matching user (404)', async () => {
    const { fetchFn } = stubFetch({ consoleStatus: 404 })
    expect(await resolveOwnerPrincipal(options(fetchFn), OWNER)).toBeNull()
  })

  test('caches a successful resolution (second call makes no further calls)', async () => {
    const { calls, fetchFn } = stubFetch({ hasProviderKey: true })
    await resolveOwnerPrincipal(options(fetchFn), OWNER)
    const afterFirst = calls.length
    await resolveOwnerPrincipal(options(fetchFn), OWNER)
    expect(calls.length).toBe(afterFirst)
  })

  test('does not cache a transient console failure', async () => {
    const failing = stubFetch({ consoleStatus: 503 })
    expect(await resolveOwnerPrincipal(options(failing.fetchFn), OWNER)).toBeNull()
    // A cached failure must not block a later success.
    const recovered = stubFetch({ hasProviderKey: true })
    expect(await resolveOwnerPrincipal(options(recovered.fetchFn), OWNER)).toEqual({
      hasProviderKey: true,
      principalForeignId: 'user-42'
    })
  })
})
