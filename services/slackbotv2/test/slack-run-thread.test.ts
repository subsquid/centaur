import { describe, expect, it } from 'bun:test'
import type { Message as ChatMessage } from 'chat'
import {
  dmRunThreadId,
  editSlackMessage,
  fetchSlackPermalink,
  isDmChannelMessage,
  openOwnerDm,
  runRootText,
  runStatusText,
  sendSlackMessage
} from '../src/slack-run-thread'
import type { SlackbotV2Options } from '../src/types'

type RecordedCall = { body: Record<string, unknown> | undefined; method: string; url: URL }

function harness(
  respond: (slackMethod: string, ctx: { body: Record<string, unknown> | undefined; url: URL }) => unknown
): { calls: RecordedCall[]; fetchFn: SlackbotV2Options['fetch'] } {
  const calls: RecordedCall[] = []
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const slackMethod = url.pathname.split('/').pop() ?? ''
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ body, method: init?.method ?? 'GET', url })
    return Response.json(respond(slackMethod, { body, url }) ?? { ok: true })
  }
  return { calls, fetchFn }
}

function options(fetchFn: SlackbotV2Options['fetch']): SlackbotV2Options {
  return {
    apiUrl: 'http://api.test',
    botToken: 'xoxb-test',
    fetch: fetchFn,
    signingSecret: 'secret',
    slackApiUrl: 'http://slack.test/api/'
  }
}

function message(raw: unknown, threadId = 'slack:C1:1'): ChatMessage {
  return { raw, threadId } as unknown as ChatMessage
}

describe('openOwnerDm', () => {
  it('returns the opened DM channel id', async () => {
    const { calls, fetchFn } = harness(method =>
      method === 'conversations.open' ? { ok: true, channel: { id: 'D123' } } : { ok: true }
    )
    expect(await openOwnerDm(options(fetchFn), 'U1')).toBe('D123')
    expect(calls[0]?.body).toEqual({ users: 'U1' })
    expect(calls[0]?.method).toBe('POST')
  })

  it('returns null when the bot cannot DM the user', async () => {
    const { fetchFn } = harness(() => ({ ok: false, error: 'im_disabled' }))
    expect(await openOwnerDm(options(fetchFn), 'U1')).toBeNull()
  })

  it('returns null when no channel id comes back', async () => {
    const { fetchFn } = harness(() => ({ ok: true, channel: {} }))
    expect(await openOwnerDm(options(fetchFn), 'U1')).toBeNull()
  })

  it('returns null when the request throws', async () => {
    const fetchFn = async () => {
      throw new Error('network down')
    }
    expect(await openOwnerDm(options(fetchFn), 'U1')).toBeNull()
  })
})

describe('fetchSlackPermalink', () => {
  it('returns the permalink and passes channel + message_ts', async () => {
    const { calls, fetchFn } = harness(() => ({ ok: true, permalink: 'https://slack/p1' }))
    expect(await fetchSlackPermalink(options(fetchFn), 'D1', '111.222')).toBe('https://slack/p1')
    expect(calls[0]?.url.searchParams.get('channel')).toBe('D1')
    expect(calls[0]?.url.searchParams.get('message_ts')).toBe('111.222')
    expect(calls[0]?.method).toBe('GET')
  })

  it('returns undefined on error (link is best-effort)', async () => {
    const { fetchFn } = harness(() => ({ ok: false, error: 'message_not_found' }))
    expect(await fetchSlackPermalink(options(fetchFn), 'D1', '1')).toBeUndefined()
  })
})

describe('sendSlackMessage', () => {
  it('posts a threaded message and returns its ref', async () => {
    const { calls, fetchFn } = harness(() => ({ ok: true, channel: 'D1', ts: '999.000' }))
    expect(
      await sendSlackMessage(options(fetchFn), { channel: 'D1', text: 'hi', threadTs: 'T1' })
    ).toEqual({ channel: 'D1', ts: '999.000' })
    expect(calls[0]?.body).toMatchObject({ channel: 'D1', text: 'hi', thread_ts: 'T1' })
  })

  it('omits thread_ts when posting a root message', async () => {
    const { calls, fetchFn } = harness(() => ({ ok: true, ts: '1' }))
    await sendSlackMessage(options(fetchFn), { channel: 'D1', text: 'hi' })
    expect(calls[0]?.body).not.toHaveProperty('thread_ts')
  })

  it('returns null on a Slack error', async () => {
    const { fetchFn } = harness(() => ({ ok: false, error: 'channel_not_found' }))
    expect(await sendSlackMessage(options(fetchFn), { channel: 'D1', text: 'hi' })).toBeNull()
  })
})

describe('editSlackMessage', () => {
  it('updates the message and reports success', async () => {
    const { calls, fetchFn } = harness(() => ({ ok: true }))
    expect(await editSlackMessage(options(fetchFn), { channel: 'C1', ts: '5' }, 'done')).toBe(true)
    expect(calls[0]?.body).toEqual({ channel: 'C1', text: 'done', ts: '5' })
  })

  it('reports failure on a Slack error', async () => {
    const { fetchFn } = harness(() => ({ ok: false, error: 'message_not_found' }))
    expect(await editSlackMessage(options(fetchFn), { channel: 'C1', ts: '5' }, 'x')).toBe(false)
  })
})

describe('runStatusText', () => {
  it('renders the running pointer with owner + run link', () => {
    expect(runStatusText('running', { ownerMention: '<@U1>', runPermalink: 'https://run' })).toBe(
      '▷ Running… · private run for <@U1> · <https://run|open run ↗>'
    )
  })

  it('renders the done pointer', () => {
    expect(runStatusText('done', { ownerMention: '<@U1>', runPermalink: 'https://run' })).toBe(
      '✅ Done · private run for <@U1> · <https://run|open run ↗>'
    )
  })

  it('renders the failed pointer without a link', () => {
    expect(runStatusText('failed')).toBe('⚠️ Run failed · private run')
  })
})

describe('runRootText', () => {
  it('includes a link back to the source thread', () => {
    expect(runRootText({ sourceLink: 'https://src', taskTitle: 'Fix the flaky test' })).toBe(
      '*Fix the flaky test*\n🔗 Context: <https://src|source thread>'
    )
  })

  it('omits the link when there is no source', () => {
    expect(runRootText({ taskTitle: 'Fix it' })).toBe('*Fix it*')
  })
})

describe('dmRunThreadId', () => {
  it('builds the slack:{channel}:{ts} key', () => {
    expect(dmRunThreadId('D1', '123.45')).toBe('slack:D1:123.45')
  })
})

describe('isDmChannelMessage', () => {
  it('is true for a DM message (channel_type=im)', () => {
    expect(isDmChannelMessage(message({ channel_type: 'im' }))).toBe(true)
  })

  it('is true for a D-prefixed channel id', () => {
    expect(isDmChannelMessage(message({ channel: 'D999' }))).toBe(true)
  })

  it('is false for a public channel', () => {
    expect(isDmChannelMessage(message({ channel: 'C999', channel_type: 'channel' }))).toBe(false)
  })

  it('falls back to the thread id channel segment', () => {
    expect(isDmChannelMessage(message(undefined, 'slack:D5:1'))).toBe(true)
    expect(isDmChannelMessage(message(undefined, 'slack:C5:1'))).toBe(false)
  })
})
