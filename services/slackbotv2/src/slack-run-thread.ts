import type { Message as ChatMessage } from 'chat'
import type { SlackbotV2Options } from './types'
import { isJsonObject, stringValue } from './utils'

/**
 * Slack Web API helpers for the per-owner DM run-thread topology
 * (`NEW_MULTITENANT.md`): each `@mention` spawns a private run in the mentioner's
 * 1:1 DM, and the source thread keeps a dynamic status pointer to it.
 *
 * These do their own `fetch` (via `options.fetch ?? fetch`, like `session-api.ts`
 * and `owner-principal.ts`) rather than the `@chat-adapter/slack` outbound path,
 * so they are unit-testable with an injected `fetch` and never throw into the
 * Slack hot path (failures resolve to `null`/`undefined` and callers fail closed).
 */

type SlackApiResponse = { ok?: boolean; error?: string; [key: string]: unknown }

function slackMethodUrl(slackApiUrl: string | undefined, method: string): URL {
  return new URL(method, slackApiUrl ?? 'https://slack.com/api/')
}

async function slackPost(
  options: SlackbotV2Options,
  method: string,
  body: Record<string, unknown>
): Promise<SlackApiResponse | null> {
  const fetchFn = options.fetch ?? fetch
  try {
    const response = await fetchFn(slackMethodUrl(options.slackApiUrl, method), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.botToken}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body)
    })
    const payload = await response.json().catch(() => undefined)
    return isJsonObject(payload) ? (payload as SlackApiResponse) : null
  } catch {
    return null
  }
}

async function slackGet(
  options: SlackbotV2Options,
  method: string,
  params: Record<string, string>
): Promise<SlackApiResponse | null> {
  const fetchFn = options.fetch ?? fetch
  const url = slackMethodUrl(options.slackApiUrl, method)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.botToken}` }
    })
    const payload = await response.json().catch(() => undefined)
    return isJsonObject(payload) ? (payload as SlackApiResponse) : null
  } catch {
    return null
  }
}

/** A posted Slack message we keep a handle to (for threading / updating). */
export type SlackMessageRef = { channel: string; ts: string }

/**
 * Open (or fetch) the bot's 1:1 DM channel with a user. Returns the DM channel id,
 * or `null` when the bot cannot DM them (DMs disabled, not in the workspace) or on
 * any transient failure — callers fail closed and notify in the source thread.
 */
export async function openOwnerDm(
  options: SlackbotV2Options,
  slackUserId: string
): Promise<string | null> {
  const payload = await slackPost(options, 'conversations.open', { users: slackUserId })
  if (!payload || payload.ok === false) return null
  const channel = isJsonObject(payload.channel) ? stringValue(payload.channel.id) : undefined
  return channel ?? null
}

/** Public permalink to a message; `undefined` on failure (the link is best-effort). */
export async function fetchSlackPermalink(
  options: SlackbotV2Options,
  channel: string,
  messageTs: string
): Promise<string | undefined> {
  const payload = await slackGet(options, 'chat.getPermalink', {
    channel,
    message_ts: messageTs
  })
  if (!payload || payload.ok === false) return undefined
  return stringValue(payload.permalink)
}

/** Post a message; returns its `{channel, ts}` handle, or `null` on failure. */
export async function sendSlackMessage(
  options: SlackbotV2Options,
  input: { channel: string; threadTs?: string; text: string }
): Promise<SlackMessageRef | null> {
  const payload = await slackPost(options, 'chat.postMessage', {
    channel: input.channel,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text: input.text,
    unfurl_links: false,
    unfurl_media: false
  })
  if (!payload || payload.ok === false) return null
  const ts = stringValue(payload.ts)
  if (!ts) return null
  return { channel: stringValue(payload.channel) ?? input.channel, ts }
}

/** Edit a previously posted message (the source-thread status pointer). Best-effort. */
export async function editSlackMessage(
  options: SlackbotV2Options,
  ref: SlackMessageRef,
  text: string
): Promise<boolean> {
  const payload = await slackPost(options, 'chat.update', {
    channel: ref.channel,
    ts: ref.ts,
    text
  })
  return Boolean(payload && payload.ok !== false)
}

export type RunStatusState = 'running' | 'done' | 'failed'

/**
 * Copy for the source-thread status pointer. A permalink into a private DM is
 * only openable by the owner — that is the intended privacy boundary, so the
 * text frames it as a private run rather than a broken link.
 */
export function runStatusText(
  state: RunStatusState,
  input: { ownerMention?: string; runPermalink?: string } = {}
): string {
  const heading =
    state === 'running' ? '▷ Running…' : state === 'done' ? '✅ Done' : '⚠️ Run failed'
  const who = input.ownerMention ? ` · private run for ${input.ownerMention}` : ' · private run'
  const link = input.runPermalink ? ` · <${input.runPermalink}|open run ↗>` : ''
  return `${heading}${who}${link}`
}

/** First message of the DM run-thread: a task summary + a link back to the source. */
export function runRootText(input: { taskTitle: string; sourceLink?: string }): string {
  const lines = [`*${input.taskTitle || 'Centaur run'}*`]
  if (input.sourceLink) lines.push(`🔗 Context: <${input.sourceLink}|source thread>`)
  return lines.join('\n')
}

/** The api-rs `thread_key` for a DM run-thread: `slack:{dmChannel}:{rootTs}`. */
export function dmRunThreadId(dmChannel: string, rootTs: string): string {
  return `slack:${dmChannel}:${rootTs}`
}

/**
 * Whether an inbound message arrived in a 1:1 DM with the bot. DM `message`
 * events carry `channel_type === 'im'`; otherwise Slack DM channel ids start with
 * `D`. Used to "run in place" (no source-thread status pointer) when the mention
 * already happens in the owner's DM.
 */
export function isDmChannelMessage(message: ChatMessage): boolean {
  const raw = message.raw
  if (isJsonObject(raw)) {
    const channelType = stringValue(raw.channel_type)
    if (channelType) return channelType === 'im'
    const channel = stringValue(raw.channel)
    if (channel) return channel.startsWith('D')
  }
  const channelSegment = message.threadId?.split(':')[1]
  return Boolean(channelSegment && channelSegment.startsWith('D'))
}
