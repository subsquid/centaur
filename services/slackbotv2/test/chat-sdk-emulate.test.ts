import { createHmac } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { connect } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { WebClient } from '@slack/web-api'
import { createEmulator, type Emulator } from 'emulate'
import { createMemoryState } from '@chat-adapter/state-memory'
import type { ServerNotification } from '@centaur/harness-events'
import {
  claimThreadOwner,
  createSlackbotV2,
  recoveryOwnerPrincipalForeignId,
  type SlackbotV2,
  type SlackbotV2AppendMessagesRequest,
  type SlackbotV2ApiMessage,
  type SlackbotV2CreateSessionRequest,
  type SlackbotV2ExecuteSessionRequest,
  type SlackbotV2SessionMessage
} from '../src/index'
import { clearOwnerPrincipalCacheForTests } from '../src/owner-principal'
import { clearRequesterIdentityCacheForTests } from '../src/session-api'
import type {
  SlackbotV2Options,
  SlackbotV2RenderObligation,
  SlackbotV2ThreadOwner,
  SlackbotV2ThreadState
} from '../src/types'

const BOT_TOKEN = 'xoxb-slackbotv2-emulate'
const USER_TOKEN = 'xoxp-slackbotv2-user'
const USER_B_TOKEN = 'xoxp-slackbotv2-user-b'
const SIGNING_SECRET = 'slackbotv2-signing-secret'
const BOT_USER_ID = 'U000000001'
const USER_ID = 'USLACKBOTV2USER'
const USER_B_ID = 'USLACKBOTV2USERB'
const TEAM_ID = 'T000000001'
const CHANNEL_ID = 'C000000001'
/** How real Slack renders a streamed message whose stream broke or was never stopped. */
const BROKEN_STREAM_TEXT = ':warning: Something went wrong'

let emulator: Emulator
let slackApi: PatchedSlackApi
let codexApi: MockSessionApi
let slack: WebClient
let slackB: WebClient
let slackApiUrl: string
let bot: SlackbotV2

beforeAll(async () => {
  emulator = await createEmulator({
    service: 'slack',
    port: await availablePort(4043),
    seed: {
      tokens: {
        [BOT_TOKEN]: {
          login: BOT_USER_ID,
          scopes: ['assistant:write', 'chat:write', 'channels:read', 'users:read']
        },
        [USER_TOKEN]: {
          login: USER_ID,
          scopes: ['chat:write', 'channels:read', 'users:read']
        },
        [USER_B_TOKEN]: {
          login: USER_B_ID,
          scopes: ['chat:write', 'channels:read', 'users:read']
        }
      },
      slack: {
        team: { name: 'Slackbot V2', domain: 'slackbot-v2' },
        users: [
          { name: 'tester', real_name: 'Test User', email: 'tester@example.com' },
          { name: 'builder', real_name: 'Build User', email: 'builder@example.com' }
        ],
        channels: [{ name: 'slackbot-v2' }],
        bots: [{ name: 'centaur' }],
        signing_secret: SIGNING_SECRET
      }
    }
  })
  slackApi = await startPatchedSlackApi(emulator.url)
  codexApi = await startMockCodexApi()
  slackApiUrl = `${slackApi.url}/api/`
  slack = new WebClient(USER_TOKEN, { slackApiUrl })
  slackB = new WebClient(USER_B_TOKEN, { slackApiUrl })
})

beforeEach(() => {
  clearRequesterIdentityCacheForTests()
  clearOwnerPrincipalCacheForTests()
  emulator.reset()
  slackApi.reset()
  codexApi.reset()
  bot = createTestBot()
})

afterAll(async () => {
  await codexApi?.close()
  await slackApi?.close()
  await emulator?.close()
})


const OWNER_MENTION_TEXT = `<@${BOT_USER_ID}> run the deployment check`

type DmRun = {
  dmChannel: string
  mentionTs: string
  parentTs: string
  runThreadKey: string
}

async function deliverAppMention(
  activeBot: SlackbotV2,
  input: { mentionTs: string; parentTs: string; text: string; user: string }
): Promise<void> {
  const waits: Promise<unknown>[] = []
  const response = await activeBot.app.request(
    '/api/webhooks/slack',
    signedSlackEvent({
      event_id: `Ev-${input.mentionTs}`,
      event: {
        channel: CHANNEL_ID,
        team: TEAM_ID,
        text: input.text,
        thread_ts: input.parentTs,
        ts: input.mentionTs,
        type: 'app_mention',
        user: input.user
      }
    }),
    {},
    waitUntilContext(waits)
  )
  expect(response.status).toBe(200)
  await Promise.all(waits)
}

async function deliverDmMessage(
  activeBot: SlackbotV2,
  input: { channel: string; rootTs?: string; text: string; ts: string; user: string }
): Promise<void> {
  const waits: Promise<unknown>[] = []
  const response = await activeBot.app.request(
    '/api/webhooks/slack',
    signedSlackEvent({
      event_id: `Ev-${input.ts}`,
      event: {
        channel: input.channel,
        channel_type: 'im',
        team: TEAM_ID,
        text: input.text,
        ts: input.ts,
        type: 'message',
        user: input.user,
        ...(input.rootTs ? { thread_ts: input.rootTs } : {})
      }
    }),
    {},
    waitUntilContext(waits)
  )
  expect(response.status).toBe(200)
  await Promise.all(waits)
}

async function startMentionRun(
  input: {
    bot?: SlackbotV2
    client?: WebClient
    parentText?: string
    parentTs?: string
    text?: string
    user?: string
  } = {}
): Promise<DmRun> {
  const activeBot = input.bot ?? bot
  const client = input.client ?? slack
  const user = input.user ?? USER_ID
  const parentTs =
    input.parentTs
    ?? (await postUserMessage(input.parentText ?? 'The deploy context is above.', undefined, client)).ts
  const text = input.text ?? OWNER_MENTION_TEXT
  const mention = await postUserMessage(text, parentTs, client)
  await deliverAppMention(activeBot, { mentionTs: mention.ts, parentTs, text, user })
  return {
    dmChannel: slackApi.dmChannelForUser(user) ?? '',
    mentionTs: mention.ts,
    parentTs,
    runThreadKey: codexApi.creates.at(-1)?.threadKey ?? ''
  }
}

async function openDmChannel(user = USER_ID): Promise<string> {
  const opened = (await slack.apiCall('conversations.open', { users: user })) as {
    channel?: { id?: string }
  }
  return String(opened.channel?.id)
}

async function channelTexts(channel: string): Promise<string[]> {
  const response = await slack.conversations.history({ channel, limit: 50 })
  return (response.messages ?? []).map(message => message.text ?? '')
}

async function channelReplies(channel: string, ts: string): Promise<string[]> {
  const response = await slack.conversations.replies({ channel, ts, limit: 50 })
  return (response.messages ?? []).map(message => message.text ?? '')
}

function conversationsOpenCalls(user?: string): StreamCall[] {
  return slackApi.calls.filter(
    call =>
      call.method === 'conversations.open'
      && (user === undefined || stringField(call.body.users) === user)
  )
}

function consoleFetch(config: {
  hasProviderKey?: boolean
  principalForeignId?: string
  status?: number
}): SlackbotV2Options['fetch'] {
  return async (resource, init) => {
    if (String(resource).includes('/principals/resolve_slack')) {
      if (config.status && config.status !== 200) return new Response('error', { status: config.status })
      return Response.json({
        data: {
          has_provider_key: config.hasProviderKey ?? true,
          principal_foreign_id: config.principalForeignId ?? 'user-42'
        }
      })
    }
    return fetch(resource, init)
  }
}

function failingDmOpenFetch(): SlackbotV2Options['fetch'] {
  return async (resource, init) => {
    if (String(resource).includes('conversations.open')) {
      return Response.json({ ok: false, error: 'im_disabled' })
    }
    return fetch(resource, init)
  }
}

describe('slackbotv2 per-owner DM run-threads', () => {
  it('spawns a private DM run for a channel mention and finalizes a source-thread status pointer', async () => {
    const run = await startMentionRun()

    expect(conversationsOpenCalls(USER_ID)).toHaveLength(1)
    expect(run.dmChannel).not.toBe('')
    expect(run.dmChannel).not.toBe(CHANNEL_ID)
    expect(run.runThreadKey.startsWith(`slack:${run.dmChannel}:`)).toBe(true)
    expect(run.runThreadKey).not.toBe(threadKey(run.parentTs))

    expect(codexApi.creates).toHaveLength(1)
    expect(codexApi.creates[0]?.threadKey).toBe(run.runThreadKey)
    expect(codexApi.executes).toHaveLength(1)
    expect(codexApi.executes[0]?.threadKey).toBe(run.runThreadKey)

    const startStreams = slackApi.calls.filter(call => call.method === 'chat.startStream')
    expect(startStreams.length).toBeGreaterThan(0)
    expect(startStreams.every(call => stringField(call.body.channel) === run.dmChannel)).toBe(true)

    const pointer = (await threadTexts(run.parentTs)).find(text => text.includes('private run'))
    expect(pointer).toBeDefined()
    expect(pointer).toContain('Done')
  })

  it('forwards the source-thread history into the DM run session', async () => {
    const parent = await postUserMessage('The deploy pipeline failed on step 3.')
    await postUserMessage('Logs show a connection timeout.', parent.ts)
    await startMentionRun({ parentTs: parent.ts, text: `<@${BOT_USER_ID}> investigate the failure` })

    expect(codexApi.appends).toHaveLength(1)
    const appended = sessionMessageTexts(codexApi.appends[0]!.body.messages).join('\n')
    expect(appended).toContain('The deploy pipeline failed on step 3.')
    expect(appended).toContain('Logs show a connection timeout.')
  })

  it('runs in place without a status pointer when the mention is already in a DM', async () => {
    const dmChannel = await openDmChannel(USER_ID)
    const root = await slack.chat.postMessage({ channel: dmChannel, text: 'kick off' })
    const rootTs = String(root.ts)
    slackApi.calls.length = 0 // ignore the setup conversations.open

    await deliverDmMessage(bot, {
      channel: dmChannel,
      rootTs,
      text: `<@${BOT_USER_ID}> do it here`,
      ts: '1700001000.0001',
      user: USER_ID
    })

    expect(conversationsOpenCalls()).toHaveLength(0)
    expect(codexApi.creates).toHaveLength(1)
    expect(codexApi.creates[0]?.threadKey).toBe(`slack:${dmChannel}:${rootTs}`)
    expect(codexApi.executes).toHaveLength(1)
  })

  it('lets the owner iterate by replying in the DM run-thread', async () => {
    const run = await startMentionRun()
    const rootTs = run.runThreadKey.split(':')[2]!

    await deliverDmMessage(bot, {
      channel: run.dmChannel,
      rootTs,
      text: 'also tail the logs',
      ts: '1700002000.0001',
      user: USER_ID
    })

    const runExecutes = codexApi.executes.filter(execute => execute.threadKey === run.runThreadKey)
    expect(runExecutes).toHaveLength(2)
  })

  it('spawns independent DM runs for concurrent mentions by different users in one thread', async () => {
    const parent = await postUserMessage('Shared incident thread.')
    await startMentionRun({ parentTs: parent.ts, text: `<@${BOT_USER_ID}> handle the alert`, user: USER_ID })
    await startMentionRun({
      client: slackB,
      parentTs: parent.ts,
      text: `<@${BOT_USER_ID}> page the on-call`,
      user: USER_B_ID
    })

    const dmA = slackApi.dmChannelForUser(USER_ID)
    const dmB = slackApi.dmChannelForUser(USER_B_ID)
    expect(dmA).toBeDefined()
    expect(dmB).toBeDefined()
    expect(dmA).not.toBe(dmB)
    expect(conversationsOpenCalls(USER_ID)).toHaveLength(1)
    expect(conversationsOpenCalls(USER_B_ID)).toHaveLength(1)

    expect(codexApi.creates).toHaveLength(2)
    const keys = codexApi.creates.map(create => create.threadKey)
    expect(keys.some(key => key.startsWith(`slack:${dmA}:`))).toBe(true)
    expect(keys.some(key => key.startsWith(`slack:${dmB}:`))).toBe(true)

    const pointers = (await threadTexts(parent.ts)).filter(text => text.includes('private run'))
    expect(pointers).toHaveLength(2)
  })

  it('prompts onboarding in the source thread and starts no run when the owner has no provider key', async () => {
    slackApi.setUserProfile(USER_ID, { email: 'tester@example.com', name: 'tester', real_name: 'Test User' })
    const consoleBot = createTestBot({
      consoleToken: 'console-token',
      consoleUrl: 'http://console.test',
      fetch: consoleFetch({ hasProviderKey: false })
    })
    const parent = await postUserMessage('Need a run.')
    const mention = await postUserMessage(`<@${BOT_USER_ID}> go`, parent.ts)
    await deliverAppMention(consoleBot, {
      mentionTs: mention.ts,
      parentTs: parent.ts,
      text: `<@${BOT_USER_ID}> go`,
      user: USER_ID
    })

    expect(conversationsOpenCalls()).toHaveLength(0)
    expect(codexApi.creates).toHaveLength(0)
    expect(codexApi.executes).toHaveLength(0)
    expect((await threadTexts(parent.ts)).some(text => text.includes('provider'))).toBe(true)
  })

  it('notifies the source thread and starts no run when the bot cannot open a DM', async () => {
    const failingBot = createTestBot({ fetch: failingDmOpenFetch() })
    const parent = await postUserMessage('DMs are closed for this run.')
    const mention = await postUserMessage(`<@${BOT_USER_ID}> go`, parent.ts)
    await deliverAppMention(failingBot, {
      mentionTs: mention.ts,
      parentTs: parent.ts,
      text: `<@${BOT_USER_ID}> go`,
      user: USER_ID
    })

    expect(codexApi.creates).toHaveLength(0)
    expect(codexApi.executes).toHaveLength(0)
    expect((await threadTexts(parent.ts)).some(text => text.includes("couldn't open a DM"))).toBe(true)
  })

  it('runs the DM session under the resolved owner principal when the console has a key', async () => {
    slackApi.setUserProfile(USER_ID, { email: 'tester@example.com', name: 'tester', real_name: 'Test User' })
    const consoleBot = createTestBot({
      consoleToken: 'console-token',
      consoleUrl: 'http://console.test',
      fetch: consoleFetch({ hasProviderKey: true, principalForeignId: 'user-77' })
    })
    const run = await startMentionRun({ bot: consoleBot })

    expect(run.dmChannel).not.toBe('')
    expect(codexApi.creates[0]?.body.metadata.principal_foreign_id).toBe('user-77')
    expect(codexApi.executes[0]?.body.metadata.principal_foreign_id).toBe('user-77')
  })

  it('reuses the spawned DM run-thread when Slack retries after a retryable execute failure', async () => {
    codexApi.failNextExecute = true
    const parent = await postUserMessage('Retryable run.')
    const mention = await postUserMessage(OWNER_MENTION_TEXT, parent.ts)
    const event = {
      mentionTs: mention.ts,
      parentTs: parent.ts,
      text: OWNER_MENTION_TEXT,
      user: USER_ID
    }

    const firstWaits: Promise<unknown>[] = []
    const firstResponse = await bot.app.request(
      '/api/webhooks/slack',
      signedSlackEvent({
        event_id: `Ev-${mention.ts}`,
        event: {
          channel: CHANNEL_ID,
          team: TEAM_ID,
          text: OWNER_MENTION_TEXT,
          thread_ts: parent.ts,
          ts: mention.ts,
          type: 'app_mention',
          user: USER_ID
        }
      }),
      {},
      waitUntilContext(firstWaits)
    )
    expect(firstResponse.status).toBe(503)
    await Promise.allSettled(firstWaits)

    const dmChannel = String(slackApi.dmChannelForUser(USER_ID))
    expect(dmChannel).not.toBe('undefined')

    // Slack retries the identical event: the run-thread is reused, not duplicated.
    await deliverAppMention(bot, event)

    const dmRoots = (await channelTexts(dmChannel)).filter(text => text.startsWith('*'))
    expect(dmRoots).toHaveLength(1)
    const pointers = (await threadTexts(parent.ts)).filter(text => text.includes('private run'))
    expect(pointers).toHaveLength(1)
    expect(codexApi.executes.length).toBeGreaterThanOrEqual(1)
  })

  it('honors a plain-text-only request without opening a Slack streaming card', async () => {
    const run = await startMentionRun({
      text: `<@${BOT_USER_ID}> summarize the incident, plain text only`
    })
    expect(slackApi.calls.some(call => call.method === 'chat.startStream')).toBe(false)
    const rootTs = run.runThreadKey.split(':')[2]!
    expect(
      (await channelReplies(run.dmChannel, rootTs)).some(text => text.includes('Executed request'))
    ).toBe(true)
  })

  it('recovers an unfinished DM run on startup and finalizes the source-thread status', async () => {
    const sharedState = createMemoryState()
    await sharedState.connect()

    const dmChannel = await openDmChannel(USER_ID)
    const parent = await postUserMessage('Recovery source context.')
    const status = await slack.chat.postMessage({
      channel: CHANNEL_ID,
      thread_ts: parent.ts,
      text: runStatusTextForTest('running')
    })
    const statusTs = String(status.ts)
    const rootTs = '1700009000.0001'
    const runKey = `slack:${dmChannel}:${rootTs}`
    const message = apiMessageFromSlackEvent({
      isMention: true,
      text: `<@${BOT_USER_ID}> recover this run`,
      threadId: runKey,
      ts: '1700009000.0002'
    })
    await sharedState.set(`thread-state:${runKey}`, {
      activeExecution: true,
      executedMessageIds: [message.id],
      forwardedMessageIds: [message.id],
      historyForwarded: true,
      lastEventId: 0,
      renderObligation: {
        afterEventId: 0,
        executionId: 'exe-recovery',
        message,
        sourceStatus: {
          channel: CHANNEL_ID,
          ownerMention: `<@${USER_ID}>`,
          permalink: 'https://run',
          ts: statusTs
        }
      }
    })
    await sharedState.appendToList('slackbotv2:render:index', runKey)
    codexApi.emitOutputLines(runKey, sampleCodexOutputLines('Recovered after restart.'))

    bot = createTestBot({ state: sharedState })

    await waitFor(() => slackApi.calls.some(call => call.method === 'chat.stopStream'), 3000)
    const stopStreams = slackApi.calls.filter(call => call.method === 'chat.stopStream')
    expect(stopStreams.some(call => stringField(call.body.channel) === dmChannel)).toBe(true)
    expect(
      (await channelReplies(dmChannel, rootTs)).some(text => text.includes('Recovered after restart.'))
    ).toBe(true)

    await waitFor(async () => (await threadTexts(parent.ts)).some(text => text.includes('Done')), 3000)

    const recovered = await sharedState.get<Record<string, unknown>>(`thread-state:${runKey}`)
    expect(recovered).toEqual(
      expect.objectContaining({ activeExecution: false, renderObligation: null })
    )
  })
})

function runStatusTextForTest(state: 'running' | 'done'): string {
  return `${state === 'running' ? '▷ Running…' : '✅ Done'} · private run for <@${USER_ID}> · <https://run|open run ↗>`
}

describe('claimThreadOwner', () => {
  it('lets exactly one of many concurrent first authors win the claim', async () => {
    const state = createMemoryState()
    await state.connect()
    const threadId = 'slack:C:claim-race'
    const claimants: SlackbotV2ThreadOwner[] = Array.from({ length: 8 }, (_, index) => ({
      slackUserId: `U${index}`,
      teamId: 'T'
    }))
    // Fire all claims concurrently against the shared atomic key. The
    // insert-if-absent semantics must collapse them to a single owner that
    // every caller agrees on (the winner sees its own claimant; the losers read
    // back the winner's), and never undefined (fail closed).
    const resolved = await Promise.all(
      claimants.map(claimant => claimThreadOwner(state, threadId, claimant))
    )
    const winners = new Set(resolved.map(owner => owner?.slackUserId))
    expect(winners.size).toBe(1)
    expect([...winners][0]).toBeDefined()
    // The persisted claim key matches the single winner.
    const stored = await state.get<SlackbotV2ThreadOwner>(`slackbotv2:owner:claim:${threadId}`)
    expect(stored?.slackUserId).toBe([...winners][0])
  })

  it('is immutable: a later author reads back the original owner, not itself', async () => {
    const state = createMemoryState()
    await state.connect()
    const threadId = 'slack:C:claim-immutable'
    const first = await claimThreadOwner(state, threadId, { slackUserId: 'U1', teamId: 'T' })
    const second = await claimThreadOwner(state, threadId, { slackUserId: 'U2', teamId: 'T' })
    expect(first?.slackUserId).toBe('U1')
    expect(second?.slackUserId).toBe('U1')
  })
})

describe('recoveryOwnerPrincipalForeignId', () => {
  const obligation = (principalForeignId?: string): SlackbotV2RenderObligation => ({
    afterEventId: 0,
    executionId: 'exe-1',
    message: apiMessageFromSlackEvent({
      isMention: true,
      text: 'x',
      threadId: threadKey('1.1'),
      ts: '1.1'
    }),
    ...(principalForeignId ? { principalForeignId } : {})
  })

  it('prefers the obligation-stored owner principal', () => {
    const state: SlackbotV2ThreadState = { owner: { slackUserId: 'U1', principalForeignId: 'live' } }
    expect(recoveryOwnerPrincipalForeignId(obligation('stored'), state)).toBe('stored')
  })

  it('falls back to the live thread owner principal when the obligation has none', () => {
    const state: SlackbotV2ThreadState = { owner: { slackUserId: 'U1', principalForeignId: 'live' } }
    expect(recoveryOwnerPrincipalForeignId(obligation(), state)).toBe('live')
  })

  it('is undefined when neither the obligation nor the owner carries a principal', () => {
    expect(recoveryOwnerPrincipalForeignId(obligation(), { owner: { slackUserId: 'U1' } })).toBeUndefined()
    expect(recoveryOwnerPrincipalForeignId(obligation(), null)).toBeUndefined()
  })
})

function createTestBot(
  overrides: Partial<Parameters<typeof createSlackbotV2>[0]> = {}
): SlackbotV2 {
  return createSlackbotV2({
    apiKey: 'slackbotv2-api-key',
    apiUrl: codexApi.url,
    botToken: BOT_TOKEN,
    botUserId: BOT_USER_ID,
    signingSecret: SIGNING_SECRET,
    slackApiUrl,
    state: createMemoryState(),
    ...overrides
  })
}

function sampleCodexNotifications(answer: string): ServerNotification[] {
  return [
    {
      method: 'thread/name/updated',
      params: {
        threadId: 'thread-1',
        threadName: answer.replace('Executed request', 'Codex request').replace('.', '')
      }
    },
    {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          itemsView: 'full',
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null
        }
      }
    },
    {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 2,
        item: {
          type: 'agentMessage',
          id: 'commentary-1',
          text: '',
          phase: 'commentary',
          memoryCitation: null
        }
      }
    },
    {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 4,
        item: {
          type: 'agentMessage',
          id: 'answer-1',
          text: '',
          phase: 'final_answer',
          memoryCitation: null
        }
      }
    },
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'commentary-1',
        delta: 'Checking the command output'
      }
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: 'Inspecting the event stream'
      }
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: {
          type: 'agentMessage',
          id: 'commentary-1',
          text: 'Checking the command output',
          phase: 'commentary',
          memoryCitation: null
        }
      }
    },
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: 'Implementation plan',
        plan: [
          { step: 'Inspect App Server events', status: 'completed' },
          { step: 'Stream Chat SDK chunks', status: 'inProgress' }
        ]
      }
    },
    {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 2,
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'pnpm test',
          cwd: '/repo',
          processId: 'proc-1',
          source: 'agent',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null
        }
      }
    },
    {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: 'tests passed\n'
      }
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 3,
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'pnpm test',
          cwd: '/repo',
          processId: 'proc-1',
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'tests passed\n',
          exitCode: 0,
          durationMs: 50
        }
      }
    },
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'answer-1',
        delta: answer
      }
    }
  ] as unknown as ServerNotification[]
}

function sampleCodexOutputLines(answer: string): string[] {
  return [
    ...sampleCodexNotifications(answer).map(notification => JSON.stringify(notification)),
    JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1
        }
      }
    })
  ]
}

function sessionMessageTexts(messages: SlackbotV2SessionMessage[]): string[] {
  return messages.flatMap(message =>
    message.parts.flatMap(part => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
        return [part.text]
      }
      return []
    })
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function threadKey(threadTs: string): string {
  return `slack:${CHANNEL_ID}:${threadTs}`
}

function apiMessageFromSlackEvent(input: {
  isMention: boolean
  text: string
  threadId: string
  ts: string
}): SlackbotV2ApiMessage {
  const threadTs = input.threadId.split(':')[2] ?? input.ts
  return {
    attachments: [],
    author: {
      fullName: 'Test User',
      isBot: false,
      isMe: false,
      userId: USER_ID,
      userName: 'tester'
    },
    id: input.ts,
    isMention: input.isMention,
    raw: {
      channel: CHANNEL_ID,
      team: TEAM_ID,
      team_id: TEAM_ID,
      text: input.text,
      thread_ts: threadTs,
      ts: input.ts,
      type: input.isMention ? 'app_mention' : 'message',
      user: USER_ID
    },
    teamId: TEAM_ID,
    text: input.text,
    threadId: input.threadId,
    timestamp: new Date().toISOString()
  }
}

async function postUserMessage(
  text: string,
  threadTs?: string,
  client: WebClient = slack
): Promise<{ ts: string }> {
  const response = await client.chat.postMessage({ channel: CHANNEL_ID, text, thread_ts: threadTs })
  expect(response.ok).toBe(true)
  return { ts: String(response.ts) }
}

async function threadTexts(threadTs: string): Promise<string[]> {
  const response = await slack.conversations.replies({
    channel: CHANNEL_ID,
    ts: threadTs,
    limit: 20
  })
  return (response.messages ?? []).map(message => message.text ?? '')
}

function signedSlackEvent(input: {
  event_id: string
  event: Record<string, unknown>
}): RequestInit {
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    type: 'event_callback',
    token: 'verification-token',
    team_id: TEAM_ID,
    api_app_id: 'A000000001',
    event_id: input.event_id,
    event_time: timestamp,
    event: input.event
  })
  const signature = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': `v0=${signature}`
    },
    body
  }
}

function waitUntilContext(waits: Promise<unknown>[]) {
  return {
    waitUntil(promise: Promise<unknown>) {
      waits.push(promise)
    },
    passThroughOnException() {},
    props: {}
  }
}

type MockSessionRequest<T> = {
  body: T
  threadKey: string
}

type MockSessionEventRequest = {
  afterEventId: number
  executionId?: string
  threadKey: string
}

type MockSessionEvent = {
  data: string
  event: string
  executionId?: string
  id: number
  threadKey: string
}

type MockSessionApi = {
  appends: MockSessionRequest<SlackbotV2AppendMessagesRequest>[]
  autoRespond: boolean
  close(): Promise<void>
  closeStreams(): void
  creates: MockSessionRequest<SlackbotV2CreateSessionRequest>[]
  emitOutputLine(threadKey: string, line: string, executionId?: string): void
  emitOutputLines(threadKey: string, lines: string[], executionId?: string): void
  emitSessionEvent(threadKey: string, event: string, data: unknown, executionId?: string): void
  eventRequests: MockSessionEventRequest[]
  executes: MockSessionRequest<SlackbotV2ExecuteSessionRequest>[]
  failNextEvents: boolean
  failNextExecute: boolean
  failNextExecuteAfterAccept: boolean
  holdNextExecute(): () => void
  reset(): void
  streamCount: number
  url: string
}

async function startMockCodexApi(): Promise<MockSessionApi> {
  const appends: MockSessionRequest<SlackbotV2AppendMessagesRequest>[] = []
  const creates: MockSessionRequest<SlackbotV2CreateSessionRequest>[] = []
  const eventRequests: MockSessionEventRequest[] = []
  const events: MockSessionEvent[] = []
  const executes: MockSessionRequest<SlackbotV2ExecuteSessionRequest>[] = []
  const idempotentExecutions = new Map<string, string>()
  const streams = new Set<ServerResponse>()
  let autoRespond = true
  let executeHold: Promise<void> | null = null
  let executeHoldRelease: (() => void) | null = null
  let eventId = 0
  let failNextEvents = false
  let failNextExecute = false
  let failNextExecuteAfterAccept = false
  const port = await availablePort(4063)
  const closeStreams = () => {
    for (const stream of streams) stream.end()
    streams.clear()
  }
  const server = createServer((req, res) => {
    void handleMockCodexRequest(req, res, {
      appends,
      creates,
      events,
      eventRequests,
      executes,
      get autoRespond() {
        return autoRespond
      },
      get executeHold() {
        return executeHold
      },
      get failNextExecute() {
        return failNextExecute
      },
      get failNextExecuteAfterAccept() {
        return failNextExecuteAfterAccept
      },
      get failNextEvents() {
        return failNextEvents
      },
      idempotentExecutions,
      nextEventId() {
        eventId += 1
        return eventId
      },
      port,
      setFailNextEvents(value) {
        failNextEvents = value
      },
      setFailNextExecute(value) {
        failNextExecute = value
      },
      setFailNextExecuteAfterAccept(value) {
        failNextExecuteAfterAccept = value
      },
      streams
    }).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error) }))
    })
  })
  await listen(server, port)

  const api: MockSessionApi = {
    appends,
    creates,
    eventRequests,
    executes,
    reset() {
      appends.length = 0
      creates.length = 0
      eventRequests.length = 0
      events.length = 0
      executes.length = 0
      idempotentExecutions.clear()
      executeHoldRelease?.()
      executeHold = null
      executeHoldRelease = null
      closeStreams()
      autoRespond = true
      eventId = 0
      failNextEvents = false
      failNextExecute = false
      failNextExecuteAfterAccept = false
    },
    url: `http://127.0.0.1:${port}`,
    closeStreams,
    get autoRespond() {
      return autoRespond
    },
    set autoRespond(value: boolean) {
      autoRespond = value
    },
    get failNextExecute() {
      return failNextExecute
    },
    set failNextExecute(value: boolean) {
      failNextExecute = value
    },
    get failNextExecuteAfterAccept() {
      return failNextExecuteAfterAccept
    },
    set failNextExecuteAfterAccept(value: boolean) {
      failNextExecuteAfterAccept = value
    },
    get failNextEvents() {
      return failNextEvents
    },
    set failNextEvents(value: boolean) {
      failNextEvents = value
    },
    holdNextExecute() {
      if (executeHoldRelease) throw new Error('execute is already held')
      executeHold = new Promise(resolve => {
        executeHoldRelease = resolve
      })
      return () => {
        const release = executeHoldRelease
        executeHoldRelease = null
        executeHold = null
        release?.()
      }
    },
    get streamCount() {
      return streams.size
    },
    emitOutputLine(threadKey: string, line: string, executionId?: string) {
      emitMockSessionEvent({
        data: line,
        event: 'session.output.line',
        executionId,
        events,
        id: ++eventId,
        streams,
        threadKey
      })
    },
    emitOutputLines(threadKey: string, lines: string[], executionId?: string) {
      for (const line of lines) api.emitOutputLine(threadKey, line, executionId)
    },
    emitSessionEvent(threadKey: string, event: string, data: unknown, executionId?: string) {
      emitMockSessionEvent({
        data: typeof data === 'string' ? data : JSON.stringify(data),
        event,
        executionId,
        events,
        id: ++eventId,
        streams,
        threadKey
      })
    },
    async close() {
      closeStreams()
      await closeServer(server)
    }
  }
  return api
}

async function handleMockCodexRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    appends: MockSessionRequest<SlackbotV2AppendMessagesRequest>[]
    autoRespond: boolean
    creates: MockSessionRequest<SlackbotV2CreateSessionRequest>[]
    events: MockSessionEvent[]
    eventRequests: MockSessionEventRequest[]
    executeHold: Promise<void> | null
    executes: MockSessionRequest<SlackbotV2ExecuteSessionRequest>[]
    failNextExecuteAfterAccept: boolean
    failNextEvents: boolean
    failNextExecute: boolean
      idempotentExecutions: Map<string, string>
    nextEventId(): number
    port: number
    setFailNextEvents(value: boolean): void
    setFailNextExecute(value: boolean): void
    setFailNextExecuteAfterAccept(value: boolean): void
    streams: Set<ServerResponse>
  }
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${input.port}`)
  const match = /^\/api\/session\/([^/]+)(?:\/(messages|execute|events))?$/.exec(url.pathname)
  if (!match?.[1]) {
    await sendWebResponse(res, new Response('not found', { status: 404 }))
    return
  }
  const threadKey = decodeURIComponent(match[1])
  const endpoint = match[2] ?? 'session'

  if (endpoint === 'session') {
    const request = await nodeRequestToWebRequest(req, url)
    const body = (await request.json()) as SlackbotV2CreateSessionRequest
    input.creates.push({ threadKey, body })
    await sendWebResponse(
      res,
      Response.json({
        thread_key: threadKey,
        sandbox_id: null,
        harness_type: body.harness_type,
        harness_thread_id: null,
        status: 'active'
      })
    )
    return
  }

  if (endpoint === 'events') {
    const afterEventId = Number.parseInt(url.searchParams.get('after_event_id') ?? '0', 10) || 0
    const executionId = url.searchParams.get('execution_id') || undefined
    input.eventRequests.push({ threadKey, afterEventId, executionId })
    if (input.failNextEvents) {
      input.setFailNextEvents(false)
      await sendWebResponse(
        res,
        new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
      )
      return
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream'
    })
    input.streams.add(res)
    for (const event of input.events) {
      if (
        event.threadKey === threadKey
        && event.id > afterEventId
        && (!executionId || !event.executionId || event.executionId === executionId)
      ) {
        writeMockSseEvent(res, event)
      }
    }
    req.once('close', () => {
      input.streams.delete(res)
    })
    return
  }

  const request = await nodeRequestToWebRequest(req, url)
  if (endpoint === 'messages') {
    const body = (await request.json()) as SlackbotV2AppendMessagesRequest
    input.appends.push({ threadKey, body })
    await sendWebResponse(res, Response.json({ ok: true, message_ids: body.messages.map((_, index) => `msg-${index + 1}`) }))
    return
  }

  const body = (await request.json()) as SlackbotV2ExecuteSessionRequest
  input.executes.push({ threadKey, body })
  if (input.failNextExecute) {
    input.setFailNextExecute(false)
    await sendWebResponse(res, new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }))
    return
  }
  if (input.executeHold) await input.executeHold
  const idempotencyMapKey = body.idempotency_key
    ? `${threadKey}:${body.idempotency_key}`
    : undefined
  const existingExecutionId = idempotencyMapKey
    ? input.idempotentExecutions.get(idempotencyMapKey)
    : undefined
  const executionId =
    existingExecutionId ?? `exe-${input.idempotentExecutions.size + input.executes.length}`
  if (idempotencyMapKey && !existingExecutionId) {
    input.idempotentExecutions.set(idempotencyMapKey, executionId)
  }
  if (!existingExecutionId && input.autoRespond) {
    for (const line of sampleCodexOutputLines(`Executed request ${input.idempotentExecutions.size}.`)) {
      emitMockSessionEvent({
        data: line,
        event: 'session.output.line',
        executionId,
        events: input.events,
        id: input.nextEventId(),
        streams: input.streams,
        threadKey
      })
    }
  }
  if (input.failNextExecuteAfterAccept) {
    input.setFailNextExecuteAfterAccept(false)
    await sendWebResponse(
      res,
      new Response('response lost after accept', { status: 503, statusText: 'Service Unavailable' })
    )
    return
  }
  await sendWebResponse(
    res,
    Response.json({
      ok: true,
      execution_id: executionId,
      thread_key: threadKey,
      status: 'completed'
    })
  )
}

function emitMockSessionEvent(input: {
  data: string
  event: string
  executionId?: string
  events: MockSessionEvent[]
  id: number
  streams: Set<ServerResponse>
  threadKey: string
}): void {
  const event: MockSessionEvent = {
    data: input.data,
    event: input.event,
    executionId: input.executionId,
    id: input.id,
    threadKey: input.threadKey
  }
  input.events.push(event)
  for (const stream of input.streams) writeMockSseEvent(stream, event)
}

function writeMockSseEvent(stream: ServerResponse, event: MockSessionEvent): void {
  stream.write(`id: ${event.id}\n`)
  stream.write(`event: ${event.event}\n`)
  for (const line of event.data.split('\n')) {
    stream.write(`data: ${line}\n`)
  }
  stream.write('\n')
}

type PatchedSlackApi = {
  calls: StreamCall[]
  close(): Promise<void>
  dmChannelForUser(userId: string): string | undefined
  failRepliesWithThreadNotFound(channel: string, ts: string): void
  failStreamAppendsAfter(count: number, error: string): void
  failStreamStopsLongerThan(maxChars: number): void
  reset(): void
  setUserProfile(userId: string, profile: Record<string, unknown>): void
  userProfileMethodRequestCount(userId: string, method: string): number
  userProfileRequestCount(userId: string): number
  url: string
}

type StreamCall = {
  body: Record<string, unknown>
  method:
    | 'assistant.threads.setStatus'
    | 'assistant.threads.setTitle'
    | 'chat.startStream'
    | 'chat.appendStream'
    | 'chat.stopStream'
    | 'conversations.open'
    | 'chat.getPermalink'
  streamTs?: string
}

type StreamRecord = {
  channel: string
  text: string
  ts: string
}

async function startPatchedSlackApi(emulatorUrl: string): Promise<PatchedSlackApi> {
  const upstreamUrl = loopbackUrl(emulatorUrl)
  const calls: StreamCall[] = []
  const userProfiles = new Map<string, Record<string, unknown>>()
  const userProfileRequests = new Map<string, number>()
  const threadNotFoundReplies = new Set<string>()
  let maxStreamStopChars: number | null = null
  const appendFailure: { error: string; remaining: number } = { error: '', remaining: -1 }
  const streams = new Map<string, StreamRecord>()
  const dmChannels = new Map<string, string>()
  const port = await availablePort(4053)
  const server = createServer((req, res) => {
    void handlePatchedSlackRequest(req, res, {
      appendFailure,
      calls,
      dmChannels,
      maxStreamStopChars,
      port,
      streams,
      threadNotFoundReplies,
      userProfiles,
      userProfileRequests,
      upstreamUrl
    }).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    })
  })
  await listen(server, port)
  return {
    calls,
    url: `http://127.0.0.1:${port}`,
    dmChannelForUser(userId: string) {
      return dmChannels.get(userId)
    },
    failRepliesWithThreadNotFound(channel: string, ts: string) {
      threadNotFoundReplies.add(slackReplyKey(channel, ts))
    },
    failStreamAppendsAfter(count: number, error: string) {
      appendFailure.remaining = count
      appendFailure.error = error
    },
    failStreamStopsLongerThan(maxChars: number) {
      maxStreamStopChars = maxChars
    },
    reset() {
      calls.length = 0
      maxStreamStopChars = null
      appendFailure.remaining = -1
      appendFailure.error = ''
      threadNotFoundReplies.clear()
      streams.clear()
      userProfiles.clear()
      userProfileRequests.clear()
      dmChannels.clear()
    },
    setUserProfile(userId: string, profile: Record<string, unknown>) {
      userProfiles.set(userId, profile)
    },
    userProfileMethodRequestCount(userId: string, method: string) {
      return userProfileRequests.get(`${method}:${userId}`) ?? 0
    },
    userProfileRequestCount(userId: string) {
      return userProfileRequests.get(userId) ?? 0
    },
    close: () => closeServer(server)
  }
}

async function handlePatchedSlackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    appendFailure: { error: string; remaining: number }
    calls: StreamCall[]
    dmChannels: Map<string, string>
    maxStreamStopChars: number | null
    port: number
    streams: Map<string, StreamRecord>
    threadNotFoundReplies: Set<string>
    userProfiles: Map<string, Record<string, unknown>>
    userProfileRequests: Map<string, number>
    upstreamUrl: string
  }
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${input.port}`)
  const request = await nodeRequestToWebRequest(req, url)

  if (url.pathname.endsWith('/files/captured.png') || url.pathname.endsWith('/captured.png')) {
    await sendWebResponse(
      res,
      new Response('captured-image', {
        headers: { 'content-type': 'image/png' }
      })
    )
    return
  }

  if (
    url.pathname.endsWith('/files/large-upload.mp4')
    || url.pathname.endsWith('/large-upload.mp4')
  ) {
    await sendWebResponse(
      res,
      new Response(new Uint8Array(2 * 1024 * 1024), {
        headers: { 'content-type': 'video/mp4' }
      })
    )
    return
  }

  const path = normalizeApiPath(url.pathname)
  if (path === '/api/assistant.threads.setStatus') {
    const body = await requestBody(request)
    input.calls.push({ method: 'assistant.threads.setStatus', body })
    await sendWebResponse(res, Response.json({ ok: true }))
    return
  }
  if (path === '/api/assistant.threads.setTitle') {
    const body = await requestBody(request)
    input.calls.push({ method: 'assistant.threads.setTitle', body })
    await sendWebResponse(res, Response.json({ ok: true }))
    return
  }
  if (path === '/api/users.info' || path === '/api/users.profile.get') {
    const userId = url.searchParams.get('user') ?? stringField((await requestBody(request)).user)
    input.userProfileRequests.set(userId, (input.userProfileRequests.get(userId) ?? 0) + 1)
    input.userProfileRequests.set(path, (input.userProfileRequests.get(path) ?? 0) + 1)
    input.userProfileRequests.set(`${path}:${userId}`, (input.userProfileRequests.get(`${path}:${userId}`) ?? 0) + 1)
    const profile = input.userProfiles.get(userId) ?? {
      name: 'tester',
      real_name: 'Test User',
      fields: {}
    }
    if (path === '/api/users.info') {
      await sendWebResponse(
        res,
        Response.json({
          ok: true,
          user: {
            id: userId,
            name: profile.name,
            real_name: profile.real_name,
            profile
          }
        })
      )
      return
    }
    await sendWebResponse(res, Response.json({ ok: true, profile }))
    return
  }
  if (path === '/api/conversations.open') {
    // The emulator has no conversations.open; lazily create a real channel per
    // user (so posts/streams into the DM work) and return it as the DM channel.
    const body = await requestBody(request)
    const user = stringField(body.users)
    input.calls.push({ method: 'conversations.open', body })
    let channelId = input.dmChannels.get(user)
    if (!channelId && user) {
      const created = await postSlack(input.upstreamUrl, request, '/api/conversations.create', {
        name: `dm-${user.toLowerCase()}`
      })
      const channel = created.channel
      channelId = isRecord(channel) ? stringField(channel.id) : ''
      if (channelId) input.dmChannels.set(user, channelId)
    }
    await sendWebResponse(
      res,
      Response.json(
        channelId
          ? { ok: true, channel: { id: channelId } }
          : { ok: false, error: 'cannot_dm_user' }
      )
    )
    return
  }
  if (path === '/api/chat.getPermalink') {
    const channel = url.searchParams.get('channel') ?? ''
    const messageTs = url.searchParams.get('message_ts') ?? ''
    input.calls.push({ method: 'chat.getPermalink', body: { channel, message_ts: messageTs } })
    await sendWebResponse(
      res,
      Response.json({
        ok: true,
        permalink: `https://slackbot-v2.slack.test/archives/${channel}/p${messageTs.replace('.', '')}`
      })
    )
    return
  }
  if (path === '/api/chat.startStream') {
    await sendWebResponse(
      res,
      await startStream(input.upstreamUrl, request, input.streams, input.calls)
    )
    return
  }
  if (path === '/api/chat.appendStream') {
    await sendWebResponse(
      res,
      await appendStream(input.upstreamUrl, request, input.streams, input.calls, input.appendFailure)
    )
    return
  }
  if (path === '/api/chat.stopStream') {
    await sendWebResponse(
      res,
      await stopStream(
        input.upstreamUrl,
        request,
        input.streams,
        input.calls,
        input.maxStreamStopChars
      )
    )
    return
  }
  if (path === '/api/conversations.replies') {
    const body = await requestBody(request.clone())
    if (
      input.threadNotFoundReplies.has(
        slackReplyKey(stringField(body.channel), stringField(body.ts))
      )
    ) {
      await sendWebResponse(res, Response.json({ ok: false, error: 'thread_not_found' }))
      return
    }
  }

  const body = await request.arrayBuffer()
  const proxied = await fetch(new URL(`${path}${url.search}`, input.upstreamUrl), {
    method: request.method,
    headers: request.headers,
    body: body.byteLength > 0 ? body : undefined
  })
  await sendWebResponse(res, proxied)
}

function loopbackUrl(value: string): string {
  const url = new URL(value)
  url.hostname = '127.0.0.1'
  return url.toString()
}

async function nodeRequestToWebRequest(
  req: IncomingMessage,
  url: URL
): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = Buffer.concat(chunks)
  return new Request(url, {
    body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    headers,
    method: req.method
  })
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  res.statusMessage = response.statusText
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  if (response.body === null || response.status === 204) {
    res.end()
    return
  }
  res.end(Buffer.from(await response.arrayBuffer()))
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function startStream(
  emulatorUrl: string,
  request: Request,
  streams: Map<string, StreamRecord>,
  calls: StreamCall[]
): Promise<Response> {
  const body = await requestBody(request)
  const channel = stringField(body.channel)
  const threadTs = stringField(body.thread_ts)
  const text = streamBodyText(body) || ' '
  const posted = await postSlack(emulatorUrl, request, '/api/chat.postMessage', {
    channel,
    thread_ts: threadTs || undefined,
    text
  })
  if (!posted.ok) return Response.json(posted)
  const ts = stringField(posted.ts)
  calls.push({ method: 'chat.startStream', body, streamTs: ts })
  streams.set(streamKey(channel, ts), { channel, ts, text })
  return Response.json({ ok: true, channel, ts })
}

async function appendStream(
  emulatorUrl: string,
  request: Request,
  streams: Map<string, StreamRecord>,
  calls: StreamCall[],
  appendFailure: { error: string; remaining: number }
): Promise<Response> {
  const body = await requestBody(request)
  const channel = stringField(body.channel)
  const ts = stringField(body.ts)
  calls.push({ method: 'chat.appendStream', body, streamTs: ts })
  if (appendFailure.remaining === 0) {
    // The stream broke server-side: real Slack renders the message as
    // "Something went wrong" and drops the streamed content.
    await postSlack(emulatorUrl, request, '/api/chat.update', {
      channel,
      ts,
      text: BROKEN_STREAM_TEXT
    })
    return Response.json({ ok: false, error: appendFailure.error })
  }
  if (appendFailure.remaining > 0) appendFailure.remaining -= 1
  const record = streams.get(streamKey(channel, ts)) ?? { channel, ts, text: '' }
  record.text += streamBodyText(body)
  streams.set(streamKey(channel, ts), record)
  await postSlack(emulatorUrl, request, '/api/chat.update', {
    channel,
    ts,
    text: record.text || ' '
  })
  return Response.json({ ok: true, channel, ts })
}

async function stopStream(
  emulatorUrl: string,
  request: Request,
  streams: Map<string, StreamRecord>,
  calls: StreamCall[],
  maxStreamStopChars: number | null
): Promise<Response> {
  const body = await requestBody(request)
  const channel = stringField(body.channel)
  const ts = stringField(body.ts)
  calls.push({ method: 'chat.stopStream', body, streamTs: ts })
  const key = streamKey(channel, ts)
  const record = streams.get(key) ?? { channel, ts, text: '' }
  const text = [record.text, streamBodyText(body)].filter(part => part.trim()).join('\n')
  if (maxStreamStopChars !== null && text.length > maxStreamStopChars) {
    // A stream that is never stopped breaks in real Slack: the message shows
    // "Something went wrong" instead of the streamed content.
    await postSlack(emulatorUrl, request, '/api/chat.update', {
      channel,
      ts,
      text: BROKEN_STREAM_TEXT
    })
    return Response.json({ ok: false, error: 'msg_too_long' })
  }
  await postSlack(emulatorUrl, request, '/api/chat.update', {
    channel,
    ts,
    text: text || record.text || ' '
  })
  streams.delete(key)
  return Response.json({ ok: true, channel, ts })
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return JSON.parse(raw || '{}')
  return Object.fromEntries(
    Array.from(new URLSearchParams(raw).entries()).map(([key, value]) => [
      key,
      parseMaybeJson(value)
    ])
  )
}

async function postSlack(
  emulatorUrl: string,
  original: Request,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, emulatorUrl), {
    method: 'POST',
    headers: {
      authorization: original.headers.get('authorization') ?? '',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return (await response.json()) as Record<string, unknown>
}

function streamBodyText(body: Record<string, unknown>): string {
  return [stringField(body.markdown_text), chunksText(body.chunks)].filter(Boolean).join('\n')
}

function streamChunks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((chunk): chunk is Record<string, unknown> => {
    return Boolean(chunk) && typeof chunk === 'object' && !Array.isArray(chunk)
  })
}

function chunkText(chunk: Record<string, unknown>): string {
  if (typeof chunk.text === 'string') return chunk.text
  return [chunk.title, chunk.details, chunk.output]
    .filter(part => typeof part === 'string' && part.trim())
    .join('\n')
}

function chunksText(value: unknown): string {
  return streamChunks(value)
    .map(chunkText)
    .filter(Boolean)
    .join('\n')
}

function normalizeApiPath(path: string): string {
  return path.startsWith('/api/') ? path : `/api${path}`
}

function streamKey(channel: string, ts: string): string {
  return `${channel}:${ts}`
}

function slackReplyKey(channel: string, ts: string): string {
  return `${channel}:${ts}`
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || !['[', '{'].includes(trimmed[0] ?? '')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function availablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (!(await isPortOpen(port))) return port
  }
  throw new Error(`No available port near ${preferred}`)
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(250, () => {
      socket.destroy()
      resolve(false)
    })
  })
}
