import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import {
  Chat,
  type Adapter,
  type Attachment,
  type Logger,
  type Message as ChatMessage,
  type StateAdapter,
  type Thread
} from 'chat'
import { createSlackAdapter } from '@chat-adapter/slack'
import { fetchSlackThreadReplies } from '@chat-adapter/slack/api'
import { createPostgresState } from '@chat-adapter/state-pg'
import pg from 'pg'
import {
  codexAppServerToChatSdkStream,
  type CodexAppServerToChatStreamOptions,
  type ChatSDKStreamChunk,
  type RendererEvent
} from '@centaur/rendering'
import { conflateChatSdkStream } from './conflate'
import {
  collectInitialContext,
  forwardToSessionApi,
  harnessRestartPreamble,
  isRetryableSessionApiError,
  openSessionEventStream,
  serializeAttachment,
  serializeMessage,
  sessionStreamError
} from './session-api'
import { extractMessageOverrides } from './overrides'
import { isOwnerPrincipalConfigured, resolveOwnerPrincipal } from './owner-principal'
import {
  dmRunThreadId,
  editSlackMessage,
  fetchSlackPermalink,
  isDmChannelMessage,
  openOwnerDm,
  runRootText,
  runStatusText,
  sendSlackMessage,
  type RunStatusState
} from './slack-run-thread'
import { isAllowedSlackMessage, isAllowedSlackWebhookBody } from './slack-events'
import type {
  ForwardSessionInput,
  SlackbotV2,
  SlackbotV2ApiAttachment,
  SlackbotV2ApiMessage,
  SlackbotV2ExecuteSessionResponse,
  SlackbotV2MessageMode,
  SlackbotV2Options,
  SlackbotV2RenderObligation,
  SlackbotV2RendererSource,
  SlackbotV2RunContext,
  SlackbotV2SourceStatusRef,
  SlackbotV2ThreadOwner,
  SlackbotV2ThreadState,
  SlackbotV2Trace
} from './types'
import { elapsedMs, errorMessage, noopLogger, nowMs, stringValue, traceLog } from './utils'

export type {
  SlackbotV2,
  SlackbotV2ApiAttachment,
  SlackbotV2ApiAuthor,
  SlackbotV2ApiMessage,
  SlackbotV2AppendMessagesRequest,
  SlackbotV2CreateSessionRequest,
  SlackbotV2ExecuteSessionRequest,
  SlackbotV2ExecuteSessionResponse,
  SlackbotV2Fetch,
  SlackbotV2Options,
  SlackbotV2SessionMessage,
  SlackbotV2SessionMessageRole
} from './types'

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void
}

type SlackAssistantAdapter = {
  setAssistantStatus?(
    channelId: string,
    threadTs: string,
    status: string,
    loadingMessages?: string[]
  ): Promise<void>
  setAssistantTitle?(channelId: string, threadTs: string, title: string): Promise<void>
}

const MAX_SLACK_MESSAGE_ATTACHMENTS = 20

type SlackbotV2RequestContext = {
  retryableErrors: unknown[]
  waitUntil(promise: Promise<unknown>): void
}

const requestContext = new AsyncLocalStorage<SlackbotV2RequestContext>()
const RENDER_OBLIGATION_INDEX_KEY = 'slackbotv2:render:index'
const RENDER_OBLIGATION_INDEX_MAX_LENGTH = 2000
const RENDER_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RENDER_RECOVERY_LEASE_TTL_MS = 2 * 60 * 1000
const RENDER_LEASE_REFRESH_INTERVAL_MS = 60 * 1000
const RENDER_RECOVERY_THREAD_TIMEOUT_MS = 2 * 60 * 1000
const RENDER_RECOVERY_MAX_THREAD_FAILURES = 5
const RENDER_RETRY_INITIAL_DELAY_MS = 250
const RENDER_RETRY_MAX_DELAY_MS = 5_000
const SLACK_TASK_DETAILS_MAX_CHARS = 500
const SLACK_FALLBACK_TEXT_MAX_CHARS = 35_000
const POSTGRES_CONNECT_INITIAL_DELAY_MS = 250
const POSTGRES_CONNECT_MAX_DELAY_MS = 10_000
// How long the per-mention DM run-thread mapping is kept so a Slack webhook retry
// reuses the already-spawned run instead of opening a duplicate (NEW_MULTITENANT).
const DM_RUN_STATE_TTL_MS = 24 * 60 * 60 * 1000

export function createSlackbotV2(options: SlackbotV2Options): SlackbotV2 {
  const userName = options.userName ?? 'centaur'
  const logger = options.logger ?? noopLogger
  const slack = createSlackAdapter({
    apiUrl: options.slackApiUrl,
    botToken: options.botToken,
    botUserId: options.botUserId,
    signingSecret: options.signingSecret,
    userName,
    logger
  })
  const state = options.state ?? createDefaultState(options, logger)
  const chat = new Chat<{ slack: typeof slack }, SlackbotV2ThreadState>({
    userName,
    adapters: { slack },
    state,
    onLockConflict: 'force',
    logger
  })

  chat.onNewMention(async (thread, message) => {
    if (!isAllowedSlackMessage(message, options, logger)) return
    if (isDmChannelMessage(message)) {
      // The mention already happens in the owner's 1:1 DM: run in place (the DM is
      // private and the owner gate is satisfied for free), no source-thread pointer.
      const assistantStatus = setInitialAssistantStatus(thread, options)
      try {
        await thread.subscribe()
        await syncThreadMessageToSession(thread, message, {
          initialAssistantStatusVisible: await assistantStatus,
          mode: 'execute',
          options,
          state
        })
      } catch (error) {
        if (await assistantStatus) await setAssistantStatus(thread, '')
        throw error
      }
      return
    }
    // A mention in a shared thread spawns a fresh private run in the mentioner's DM
    // (NEW_MULTITENANT); the source thread keeps only a dynamic status pointer, and
    // the DM run-thread's assistant status is set lazily inside syncThreadMessageToSession.
    await startDmRunThread(chat, thread, message, { options, state })
  })

  chat.onSubscribedMessage(async (thread, message) => {
    if (!isAllowedSlackMessage(message, options, logger)) return
    // Inside a 1:1 DM run-thread every owner reply drives a turn; in any other
    // subscribed thread only an explicit mention executes.
    const execute = message.isMention === true || isDmChannelMessage(message)
    const assistantStatus = execute
      ? setInitialAssistantStatus(thread, options)
      : Promise.resolve(false)
    try {
      await syncThreadMessageToSession(thread, message, {
        initialAssistantStatusVisible: await assistantStatus,
        mode: execute ? 'execute' : 'append',
        options,
        state
      })
    } catch (error) {
      if (await assistantStatus) await setAssistantStatus(thread, '')
      throw error
    }
  })

  const app = new Hono()
  app.get('/health', c => c.json({ ok: true, service: 'slackbotv2' }))
  const handleSlackWebhook = async (c: Context) => {
    const rawBody = await c.req.raw.clone().text()
    if (!isAllowedSlackWebhookBody(rawBody, options, logger)) {
      return new globalThis.Response('ok', { status: 200 })
    }
    const awaitHandoff = shouldAwaitSlackHandoff(rawBody)
    const handoffTasks: Promise<unknown>[] = []
    const context: SlackbotV2RequestContext = {
      retryableErrors: [],
      waitUntil: promise => waitUntil(c, promise)
    }
    const response = await requestContext.run(context, () => {
      return chat.webhooks.slack(c.req.raw, {
        waitUntil: promise => {
          if (awaitHandoff) {
            handoffTasks.push(promise)
          } else {
            waitUntil(c, promise)
          }
        }
      })
    })
    if (awaitHandoff && response.ok) {
      try {
        await Promise.all(handoffTasks)
      } catch (error) {
        if (isRetryableSessionApiError(error)) context.retryableErrors.push(error)
      }
      if (context.retryableErrors.length > 0) {
        traceLog(options, 'slackbotv2_webhook_retry_requested', undefined, {
          error: errorMessage(context.retryableErrors[0])
        })
        return new globalThis.Response('temporary upstream unavailable', { status: 503 })
      }
    }
    return new globalThis.Response(await response.text(), {
      headers: response.headers,
      status: response.status
    })
  }
  app.post('/api/webhooks/slack', handleSlackWebhook)
  app.post('/api/slack/events', handleSlackWebhook)

  if (options.recoverRenderObligationsOnStart !== false) {
    scheduleRenderObligationRecovery(chat, state, options)
  }

  return { app, chat }
}

function createDefaultState(options: SlackbotV2Options, logger: Logger): StateAdapter {
  const stateLogger = logger.child('postgres-state')
  // Own the pool so we can attach an error handler. pg.Pool emits 'error' for
  // idle clients whose connection drops (Postgres restart, or a transient blip
  // while the pod's network is still being programmed at startup). With no
  // listener, node-postgres rethrows it as an uncaught exception and the process
  // crashes/spews. Logging and swallowing lets the pool reconnect on the next query.
  const pool = new pg.Pool({ connectionString: options.postgresUrl })
  pool.on('error', error => {
    stateLogger.warn('postgres pool error', { error: errorMessage(error) })
  })
  return createPostgresState({
    client: pool,
    keyPrefix: options.stateKeyPrefix ?? 'centaur-slackbotv2',
    logger: stateLogger
  })
}

/**
 * Blocks until the state backend accepts a connection, retrying with exponential
 * backoff. The first DB connection fires within milliseconds of process start and
 * can lose a race with the pod's network programming (a one-off ECONNREFUSED).
 * Retrying instead of throwing absorbs that race; the first successful connect
 * also flips the adapter's `connected` flag, so the message path comes alive too.
 */
async function ensureStateConnected(state: StateAdapter, options: SlackbotV2Options): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await state.connect()
      if (attempt > 0) {
        traceLog(options, 'slackbotv2_postgres_connected', undefined, { attempts: attempt + 1 })
      }
      return
    } catch (error) {
      const delayMs = Math.min(
        POSTGRES_CONNECT_INITIAL_DELAY_MS * 2 ** attempt,
        POSTGRES_CONNECT_MAX_DELAY_MS
      )
      traceLog(options, 'slackbotv2_postgres_connect_retry', undefined, {
        attempt: attempt + 1,
        delay_ms: delayMs,
        error: errorMessage(error)
      })
      await sleep(delayMs)
    }
  }
}

/**
 * Persists a Slack thread update into the session API. In execute mode the create/append/execute
 * handoff completes before Slack is acknowledged; SSE rendering continues in background.
 */
async function syncThreadMessageToSession(
  thread: Thread<SlackbotV2ThreadState>,
  message: ChatMessage,
  input: {
    initialAssistantStatusVisible?: boolean
    mode: SlackbotV2MessageMode
    options: SlackbotV2Options
    state: StateAdapter
    /**
     * Present when this run lives in a DM run-thread distinct from the triggering
     * message's own thread (NEW_MULTITENANT). Forces context to be collected from
     * the SOURCE thread (`message.raw`) rather than this (DM) thread, and carries
     * the source-thread status pointer through to the obligation + finalize.
     */
    runContext?: SlackbotV2RunContext
  }
): Promise<void> {
  const traceStartedAtMs = nowMs()
  const state = (await thread.state) ?? {}
  const messageIds = new Set(state.forwardedMessageIds ?? [])
  const executedMessageIds = new Set(state.executedMessageIds ?? [])
  const shouldStartExecution =
    input.mode === 'execute' && state.activeExecution !== true && !executedMessageIds.has(message.id)
  // A DM run forwards the SOURCE thread (the mention's own raw channel/thread_ts),
  // not this DM thread — so always refresh from Slack on the first execute.
  const isDmRun = input.runContext !== undefined
  const shouldRefreshThreadContext = shouldStartExecution && (isDmRun || isSlackThreadReply(message))
  const shouldIncludeContext =
    shouldStartExecution && (state.historyForwarded !== true || shouldRefreshThreadContext)
  const isDuplicateIncrementalMessage =
    messageIds.has(message.id) && !shouldStartExecution && !shouldIncludeContext
  const trace: SlackbotV2Trace = {
    includeContext: shouldIncludeContext,
    messageId: message.id,
    mode: input.mode,
    openStream: shouldStartExecution,
    startedAtMs: traceStartedAtMs,
    threadId: thread.id
  }
  if (isDuplicateIncrementalMessage) {
    traceLog(input.options, 'slackbotv2_forward_duplicate_skipped', trace)
    if (input.initialAssistantStatusVisible) await setAssistantStatus(thread, '')
    return
  }
  traceLog(input.options, 'slackbotv2_forward_started', trace, {
    active_execution: state.activeExecution === true,
    history_forwarded: state.historyForwarded === true
  })
  const assistantStatusVisible = shouldStartExecution
    ? input.initialAssistantStatusVisible ??
      (await setInitialAssistantStatus(thread, input.options, trace))
    : false
  if (!shouldStartExecution && input.initialAssistantStatusVisible) {
    await setAssistantStatus(thread, '')
  }

  const serializeStartedAtMs = nowMs()
  const serializedMessage = await serializeMessage(message)
  const overrides = extractMessageOverrides(serializedMessage.text)
  serializedMessage.text = overrides.cleanedText
  if (overrides.harnessType || overrides.model || overrides.reasoning) {
    traceLog(input.options, 'slackbotv2_forward_overrides_parsed', trace, {
      harness_type: overrides.harnessType,
      model: overrides.model,
      reasoning: overrides.reasoning
    })
  }
  traceLog(input.options, 'slackbotv2_forward_message_serialized', trace, {
    attachment_count: serializedMessage.attachments.length,
    phase_ms: elapsedMs(serializeStartedAtMs)
  })

  // --- Thread ownership ----------------------------------------------------
  // The first author claims the thread; the bot acts ONLY on the owner's
  // messages (non-owners are ignored — no execute, no append). Ownership is
  // immutable (no transfer/fork). Claimed here, after thread state loads,
  // because the synchronous isAllowedSlackMessage gate runs before state exists.
  const authorOwner = ownerIdentityFromMessage(serializedMessage)
  let owner = state.owner
  if (!owner) {
    // No owner yet. Claim atomically against the dedicated claim key
    // (insert-if-absent): concurrent first messages are NOT serialized
    // (onLockConflict:'force'), so a setState merge would let both win. The
    // claim key is the source of truth; state.owner is its mirror.
    if (!authorOwner) {
      // First message with an unresolvable author: never run un-owned, or a
      // later (possibly different) user could claim the thread out from under
      // the real first author. Skip until an authored message arrives.
      traceLog(input.options, 'slackbotv2_owner_claim_unresolvable_author', trace, {
        message_id: serializedMessage.id
      })
      return
    }
    owner = await claimThreadOwner(input.state, thread.id, authorOwner)
    if (!owner) {
      traceLog(input.options, 'slackbotv2_owner_claim_unresolved', trace, {
        author_user_id: authorOwner.slackUserId
      })
      return
    }
    if (!state.owner) await thread.setState({ owner })
  }
  if (!authorOwner || authorOwner.slackUserId !== owner.slackUserId) {
    traceLog(input.options, 'slackbotv2_owner_gate_ignored', trace, {
      author_user_id: authorOwner?.slackUserId,
      owner_user_id: owner.slackUserId
    })
    return
  }

  // Resolve the owner's personal principal so api-rs runs the session under the
  // owner's provider key. The principal is bound ONCE at first session create
  // (Part 2 immutability), and createSession runs even for a non-mention append,
  // so this must ride EVERY forward — not just executes — or the thread binds to
  // the channel-derived principal and can never rebind to the owner.
  let principalForeignId: string | undefined
  if (isOwnerPrincipalConfigured(input.options)) {
    const resolved = await resolveOwnerPrincipal(input.options, owner)
    if (!resolved || !resolved.hasProviderKey) {
      // Fail closed: never fall back to a shared key. Prompt onboarding on an
      // execute trigger; silently skip a non-mention append (no prompt spam).
      traceLog(input.options, 'slackbotv2_owner_no_provider_key', trace, {
        has_provider_key: resolved?.hasProviderKey === true,
        owner_user_id: owner.slackUserId,
        resolved: Boolean(resolved)
      })
      if (shouldStartExecution) await postOwnerOnboardingPrompt(thread, owner, input.options)
      return
    }
    principalForeignId = resolved.principalForeignId
    if (owner.principalForeignId !== principalForeignId) {
      owner = { ...owner, principalForeignId }
      await thread.setState({ owner })
    }
  }

  let context: SlackbotV2ApiMessage[] | undefined

  if (shouldIncludeContext) {
    const contextStartedAtMs = nowMs()
    context = shouldRefreshThreadContext
      ? await collectSlackThreadContext(input.options, message)
      : await collectInitialContext(thread, message)
    // collectInitialContext re-serializes the current message; mirror the
    // flag-stripped text on that copy too.
    for (const item of context) {
      if (item.id === serializedMessage.id) item.text = serializedMessage.text
    }
    traceLog(input.options, 'slackbotv2_forward_context_collected', trace, {
      message_count: context.length,
      phase_ms: elapsedMs(contextStartedAtMs)
    })
  } else {
    traceLog(input.options, 'slackbotv2_forward_context_skipped', trace, {
      message_count: 1
    })
  }

  let lastEventId = state.lastEventId ?? 0
  const renderLease: { release: (() => Promise<void>) | null } = { release: null }
  const candidateMessages = context ?? [serializedMessage]
  const messagesToAppend = candidateMessages.filter(item => !messageIds.has(item.id))

  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executeContextMessages:
      shouldStartExecution && shouldIncludeContext ? candidateMessages : undefined,
    executeMessage: shouldStartExecution ? serializedMessage : undefined,
    // A harness override only applies when this message starts an execution;
    // restarting the thread out from under an active execution would kill it.
    harnessType: shouldStartExecution ? overrides.harnessType : undefined,
    messages: messagesToAppend,
    model: overrides.model,
    reasoning: overrides.reasoning,
    onEventId: eventId => {
      lastEventId = Math.max(lastEventId, eventId)
    },
    openStream: false,
    ownerSlackUserId: owner.slackUserId,
    principalForeignId,
    threadId: thread.id,
    trace
  }

  // The previous harness's conversation state dies with its sandbox on a
  // restart, so re-feed the Slack thread transcript with this turn.
  const handleSessionRestarted = async (): Promise<void> => {
    const history = context ?? (await collectInitialContext(thread, message))
    forwardInput.contextPreamble = harnessRestartPreamble(history, serializedMessage.id)
    traceLog(input.options, 'slackbotv2_forward_restart_context_built', trace, {
      history_message_count: history.length,
      preamble_chars: forwardInput.contextPreamble?.length ?? 0
    })
  }

  const commitMessagesAppended = async (): Promise<void> => {
    const latest = (await thread.state) ?? {}
    const latestMessageIds = new Set(latest.forwardedMessageIds ?? [])
    for (const item of messagesToAppend) latestMessageIds.add(item.id)
    await thread.setState({
      forwardedMessageIds: Array.from(latestMessageIds).slice(-1000),
      historyForwarded: latest.historyForwarded || shouldIncludeContext,
      lastEventId
    })
    traceLog(input.options, 'slackbotv2_forward_messages_committed', trace, {
      appended_message_count: messagesToAppend.length,
      forwarded_message_count: Math.min(latestMessageIds.size, 1000)
    })
  }

  const commitExecutionStarted = async (
    execution: SlackbotV2ExecuteSessionResponse
  ): Promise<void> => {
    const latest = (await thread.state) ?? {}
    const latestExecutedMessageIds = new Set(latest.executedMessageIds ?? [])
    latestExecutedMessageIds.add(serializedMessage.id)
    forwardInput.executionId = execution.execution_id
    // Take the render lease before the obligation becomes visible so a
    // concurrent recovery sweep never claims it while this process is about
    // to render it live.
    try {
      renderLease.release = await acquireRenderLease(input.state, thread.id)
    } catch (error) {
      traceLog(input.options, 'slackbotv2_render_lease_acquire_failed', trace, {
        error: errorMessage(error)
      })
    }
    await thread.setState({
      activeExecution: true,
      executedMessageIds: Array.from(latestExecutedMessageIds).slice(-1000),
      lastEventId,
      renderObligation: {
        afterEventId: lastEventId,
        executionId: execution.execution_id,
        message: serializedMessage,
        // Persist the owner principal so the recovery sweep re-forwards under it
        // (Part 3d/3f) without a fresh Slack-profile + console round-trip.
        principalForeignId,
        // Carry the source-thread status pointer so the recovery sweep can finalize
        // it (✅/❌) after a crash (NEW_MULTITENANT).
        ...(input.runContext?.sourceStatus
          ? { sourceStatus: input.runContext.sourceStatus }
          : {})
      }
    })
    await indexRenderObligation(input.state, {
      options: input.options,
      threadId: thread.id,
      trace
    })
    traceLog(input.options, 'slackbotv2_forward_execution_committed', trace, {
      execution_id: execution.execution_id,
      executed_message_count: Math.min(latestExecutedMessageIds.size, 1000)
    })
  }

  if (!shouldStartExecution) {
    try {
      if (messagesToAppend.length > 0) {
        await forwardToSessionApi(input.options, forwardInput, {
          onMessagesAppended: commitMessagesAppended
        })
      }
    } catch (error) {
      if (isRetryableSessionApiError(error)) {
        const context = requestContext.getStore()
        if (context) {
          context.retryableErrors.push(error)
          try {
            await input.state.delete(`dedupe:slack:${message.id}`)
          } catch (deleteError) {
            traceLog(input.options, 'slackbotv2_webhook_retry_dedupe_clear_failed', trace, {
              error: errorMessage(deleteError)
            })
          }
          traceLog(input.options, 'slackbotv2_webhook_retry_marked', trace, {
            error: errorMessage(error)
          })
        }
      }
      throw error
    }
    traceLog(input.options, 'slackbotv2_forward_complete', trace)
    return
  }

  try {
    await thread.setState({ activeExecution: true })
    traceLog(input.options, 'slackbotv2_forward_active_execution_marked', trace)
    await forwardToSessionApi(input.options, forwardInput, {
      onExecutionStarted: commitExecutionStarted,
      onMessagesAppended: commitMessagesAppended,
      onSessionRestarted: handleSessionRestarted
    })
    scheduleExecutionRender(
      thread,
      serializedMessage,
      input.options,
      forwardInput,
      () => lastEventId,
      renderLease,
      assistantStatusVisible,
      trace
    )
    traceLog(input.options, 'slackbotv2_forward_complete', trace, {
      last_event_id: lastEventId
    })
  } catch (error) {
    // The live render is not happening; let the recovery sweep claim the
    // obligation (if one was committed) as soon as it scans.
    await renderLease.release?.()
    const latest = (await thread.state) ?? {}
    await thread.setState({
      activeExecution: false,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId)
    })
    if (isRetryableSessionApiError(error)) {
      const context = requestContext.getStore()
      if (context) {
        context.retryableErrors.push(error)
        try {
          await input.state.delete(`dedupe:slack:${message.id}`)
        } catch (deleteError) {
          traceLog(input.options, 'slackbotv2_webhook_retry_dedupe_clear_failed', trace, {
            error: errorMessage(deleteError)
          })
        }
        traceLog(input.options, 'slackbotv2_webhook_retry_marked', trace, {
          error: errorMessage(error)
        })
        if (assistantStatusVisible) await setAssistantStatus(thread, '')
        throw error
      }
    }
    try {
      await renderExecutionStream(
        thread,
        streamError(error),
        serializedMessage,
        input.options,
        trace,
        assistantStatusVisible
      )
    } catch (renderError) {
      // The error notice is best-effort; a Slack render failure here must not
      // mask the original forward failure.
      traceLog(input.options, 'slackbotv2_forward_error_notice_render_failed', trace, {
        error: errorMessage(renderError)
      })
    }
    // The run never started: finalize the source-thread status pointer as failed.
    await finalizeSourceStatus(input.options, input.runContext?.sourceStatus, 'failed', trace)
    traceLog(input.options, 'slackbotv2_forward_complete', trace, {
      latest_active_execution: latest.activeExecution === true,
      last_event_id: lastEventId
    })
  }
}

function scheduleExecutionRender(
  thread: Thread<SlackbotV2ThreadState>,
  message: SlackbotV2ApiMessage,
  options: SlackbotV2Options,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  renderLease: { release: (() => Promise<void>) | null },
  assistantStatusVisible: boolean,
  trace?: SlackbotV2Trace
): void {
  const promise = (async () => {
    try {
      let attempt = 0
      while (true) {
        const result = await renderExecutionAttempt(
          thread,
          message,
          options,
          input,
          getLastEventId,
          assistantStatusVisible,
          trace
        )
        if (result === 'complete') return
        const delayMs = renderRetryDelayMs(attempt)
        attempt += 1
        traceLog(options, 'slackbotv2_render_retry_scheduled', trace, {
          retry_delay_ms: delayMs,
          retry_attempt: attempt
        })
        await sleep(delayMs)
      }
    } finally {
      await renderLease.release?.()
    }
  })()
  backgroundWaitUntil(promise)
}

async function renderExecutionAttempt(
  thread: Thread<SlackbotV2ThreadState>,
  message: SlackbotV2ApiMessage,
  options: SlackbotV2Options,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  assistantStatusVisible: boolean,
  trace?: SlackbotV2Trace
): Promise<'complete' | 'retry'> {
  let rendered = false
  let retry = false
  let fallbackLastEventId = 0
  try {
    await renderExecutionStream(
      thread,
      streamSessionAfterHandoff(options, input),
      message,
      options,
      trace,
      assistantStatusVisible
    )
    rendered = true
    traceLog(options, 'slackbotv2_render_complete', trace)
    return 'complete'
  } catch (error) {
    // Check the Slack adapter's delivery annotation before retryability:
    // Slack network failures can surface as TypeError/AbortError, which would
    // otherwise be misclassified as retryable session API errors and re-render
    // the whole stream instead of posting the durable final answer.
    const answerLost = slackAnswerLost(error)
    if (answerLost === undefined && isRetryableSessionApiError(error)) {
      retry = true
      traceLog(options, 'slackbotv2_render_deferred', trace, {
        error: errorMessage(error),
        last_event_id: getLastEventId()
      })
      return 'retry'
    }
    if (answerLost === false) {
      // The Slack stream broke only after the final answer became visible
      // (for example a progress-card stop failed). Reposting would duplicate
      // the answer, so record the failure and finish.
      rendered = true
      traceLog(options, 'slackbotv2_render_failed_answer_visible', trace, {
        error: errorMessage(error)
      })
      return 'complete'
    }
    traceLog(options, 'slackbotv2_render_failed', trace, {
      error: errorMessage(error),
      slack_answer_lost: answerLost ?? 'unknown'
    })
    const replaceMessageId = isSlackStreamSizeLimitError(error)
      ? slackStreamMessageId(error)
      : undefined
    if (isSlackStreamSizeLimitError(error) && !replaceMessageId) {
      // Size-limit failures should be prevented by stream segmentation. If
      // Slack still rejects a stream as too large but does not expose the
      // failed stream message id, do not post a separate duplicate fallback.
      rendered = true
      traceLog(options, 'slackbotv2_render_failed_size_limit_no_replacement', trace, {
        error: errorMessage(error),
        slack_answer_lost: answerLost ?? 'unknown'
      })
      return 'complete'
    }
    const fallback = await renderFallbackFinalAnswer(
      thread,
      options,
      {
        afterEventId: input.afterEventId,
        executionId: input.executionId,
        threadId: input.threadId
      },
      trace,
      replaceMessageId ? { replaceMessageId } : undefined
    )
    if (fallback) {
      rendered = true
      fallbackLastEventId = fallback.lastEventId
      return 'complete'
    }
    throw error
  } finally {
    const latest = (await thread.state) ?? {}
    // Read the source-thread status pointer before the obligation is cleared, so a
    // completed DM run finalizes it (NEW_MULTITENANT).
    const sourceStatus = latest.renderObligation?.sourceStatus
    await thread.setState({
      activeExecution: retry,
      lastEventId: Math.max(latest.lastEventId ?? 0, getLastEventId(), fallbackLastEventId),
      ...(rendered ? { renderObligation: null } : {})
    })
    if (rendered) {
      await finalizeSourceStatus(options, sourceStatus, 'done', trace)
    }
    traceLog(options, 'slackbotv2_render_finalized', trace, {
      obligation_cleared: rendered,
      retry_scheduled: retry,
      last_event_id: getLastEventId()
    })
  }
}

/**
 * Reads the delivery annotation the Slack chat adapter attaches to streaming
 * errors. `false` means the stream's final answer was confirmed visible before
 * the failure; `true` means it was definitely not; `undefined` means the error
 * did not come through the adapter's streaming path.
 */
function slackAnswerLost(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as { slackAnswerLost?: unknown }).slackAnswerLost
  return typeof value === 'boolean' ? value : undefined
}

function isSlackStreamSizeLimitError(error: unknown): boolean {
  const code = slackStreamErrorCode(error)
  return code.includes('msg_too_long') || code.includes('msg_blocks_too_long')
}

function slackStreamMessageId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as { slackStreamMessageId?: unknown }).slackStreamMessageId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function slackStreamErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error === 'string' ? error : ''
  const record = error as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  const data = record.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const dataError = (data as Record<string, unknown>).error
    if (typeof dataError === 'string') return dataError
  }
  return typeof record.message === 'string' ? record.message : ''
}

const FALLBACK_OPEN_MAX_ATTEMPTS = 4

/**
 * Delivers the durable final answer as a plain thread post after the live
 * Slack streaming render failed. Replays the session event stream from the
 * execution's starting position (the control plane keeps the events durably,
 * so the terminal result is replayable even when the failed render already
 * consumed it), drains it without making Slack calls, and posts the terminal
 * result text once. Slack streaming is best-effort; this is the delivery
 * guarantee. Returns null when nothing could be delivered.
 */
async function renderFallbackFinalAnswer(
  thread: Thread,
  options: SlackbotV2Options,
  source: { afterEventId: number; executionId?: string; threadId: string },
  trace?: SlackbotV2Trace,
  replacement?: { replaceMessageId: string }
): Promise<{ lastEventId: number } | null> {
  const startedAtMs = nowMs()
  let lastEventId = source.afterEventId
  try {
    let stream: AsyncIterable<SlackbotV2RendererSource> | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        stream = await openSessionEventStream(options, {
          afterEventId: source.afterEventId,
          executionId: source.executionId,
          onEventId: eventId => {
            lastEventId = Math.max(lastEventId, eventId)
          },
          threadId: source.threadId,
          trace
        })
        break
      } catch (error) {
        if (!isRetryableSessionApiError(error) || attempt + 1 >= FALLBACK_OPEN_MAX_ATTEMPTS) {
          throw error
        }
        await sleep(renderRetryDelayMs(attempt))
      }
    }
    const fallback = new SlackRenderFallback()
    const chatStream = fallback.collectChatSdk(
      slackSafeChatSdkStream(
        codexAppServerToChatSdkStream(
          fallback.collectSource(stream),
          fallbackRendererOptions(options)
        )
      )
    )
    for await (const _chunk of chatStream) {
      void _chunk
    }
    const text = fallback.text()
    if (!text) {
      traceLog(options, 'slackbotv2_render_fallback_empty', trace, {
        last_event_id: lastEventId,
        phase_ms: elapsedMs(startedAtMs)
      })
      return null
    }
    const fallbackText = truncateSlackText(text, SLACK_FALLBACK_TEXT_MAX_CHARS, 'Slack final answer')
    if (replacement) {
      await thread.adapter.editMessage(thread.id, replacement.replaceMessageId, fallbackText)
    } else {
      await thread.post(fallbackText)
    }
    traceLog(options, 'slackbotv2_render_fallback_complete', trace, {
      chars: text.length,
      last_event_id: lastEventId,
      replacement_message_id: replacement?.replaceMessageId,
      phase_ms: elapsedMs(startedAtMs)
    })
    return { lastEventId }
  } catch (error) {
    traceLog(options, 'slackbotv2_render_fallback_failed', trace, {
      error: errorMessage(error),
      phase_ms: elapsedMs(startedAtMs)
    })
    return null
  }
}

function scheduleRenderObligationRecovery(
  chat: Chat<Record<string, Adapter>, SlackbotV2ThreadState>,
  state: StateAdapter,
  options: SlackbotV2Options
): void {
  backgroundWaitUntil(
    recoverRenderObligationsWithRetry(chat, state, options)
  )
}

async function recoverRenderObligationsWithRetry(
  chat: Chat<Record<string, Adapter>, SlackbotV2ThreadState>,
  state: StateAdapter,
  options: SlackbotV2Options
): Promise<void> {
  // Wait for Postgres before scanning for obligations. This is also what warms the
  // shared pool at startup, so transient connect failures don't wedge the bot.
  await ensureStateConnected(state, options)
  const failureCounts = new Map<string, number>()
  let attempt = 0
  while (true) {
    try {
      const deferredCount = await recoverRenderObligations(chat, state, options, failureCounts)
      if (deferredCount === 0) return
      const delayMs = renderRetryDelayMs(attempt)
      attempt += 1
      traceLog(options, 'slackbotv2_render_recovery_retry_scheduled', undefined, {
        deferred_count: deferredCount,
        retry_delay_ms: delayMs,
        retry_attempt: attempt
      })
      await sleep(delayMs)
    } catch (error) {
      traceLog(options, 'slackbotv2_render_recovery_failed', undefined, {
        error: errorMessage(error)
      })
      return
    }
  }
}

async function recoverRenderObligations(
  chat: Chat<Record<string, Adapter>, SlackbotV2ThreadState>,
  state: StateAdapter,
  options: SlackbotV2Options,
  failureCounts: Map<string, number>
): Promise<number> {
  const startedAtMs = nowMs()
  await chat.initialize()
  const indexedThreadIds = await state.getList<string>(RENDER_OBLIGATION_INDEX_KEY)
  const threadIds = Array.from(new Set(indexedThreadIds))
  const timeoutMs = options.renderRecoveryThreadTimeoutMs ?? RENDER_RECOVERY_THREAD_TIMEOUT_MS
  let deferredCount = 0
  traceLog(options, 'slackbotv2_render_recovery_scan', undefined, {
    obligation_count: threadIds.length,
    phase_ms: elapsedMs(startedAtMs)
  })

  for (const threadId of threadIds) {
    try {
      const thread = chat.thread(threadId)
      const threadState = await thread.state
      const obligation = threadState?.renderObligation
      if (!obligation) continue

      // An obligation that keeps failing non-retryably (for example corrupt
      // state that can never address a Slack thread) must not poison the
      // retry loop forever: give up on it and unwedge the thread.
      if ((failureCounts.get(threadId) ?? 0) >= RENDER_RECOVERY_MAX_THREAD_FAILURES) {
        traceLog(options, 'slackbotv2_render_recovery_abandoned', undefined, {
          failure_count: failureCounts.get(threadId),
          thread_id: threadId
        })
        await thread.setState({
          activeExecution: false,
          lastEventId: threadState?.lastEventId ?? 0,
          renderObligation: null
        })
        await finalizeSourceStatus(options, obligation.sourceStatus, 'failed')
        continue
      }

      const leaseToken = randomUUID()
      const leaseAcquired = await state.setIfNotExists(
        renderRecoveryLeaseKey(threadId),
        leaseToken,
        RENDER_RECOVERY_LEASE_TTL_MS
      )
      if (!leaseAcquired) {
        // Another holder (or a lease from a crashed pass, pending TTL expiry)
        // owns this thread. Count it as deferred so the retry loop keeps
        // running until the obligation is actually resolved.
        deferredCount += 1
        traceLog(options, 'slackbotv2_render_recovery_lease_skipped', undefined, {
          thread_id: threadId
        })
        continue
      }
      const releaseLease = async (): Promise<void> => {
        const activeLeaseToken = await state.get<string>(renderRecoveryLeaseKey(threadId))
        if (activeLeaseToken === leaseToken) await state.delete(renderRecoveryLeaseKey(threadId))
      }

      // A single hung recovery (for example an event stream that never
      // produces a chunk) must not block every obligation queued behind it.
      // Race a deadline; on timeout move on and leave the attempt running
      // detached - it may still finish and clear the obligation, which is why
      // the lease is kept so a later pass does not start a duplicate render.
      const recovery = recoverRenderObligation(chat, state, options, threadId, obligation, threadState)
      let outcome: { timedOut: true } | { timedOut: false; deferred: boolean }
      try {
        outcome = await Promise.race([
          recovery.then(deferred => ({ timedOut: false as const, deferred })),
          sleep(timeoutMs).then(() => ({ timedOut: true as const }))
        ])
      } catch (error) {
        await releaseLease()
        throw error
      }
      if (outcome.timedOut) {
        void recovery.catch(() => undefined)
        deferredCount += 1
        // Count timeouts toward the abandonment budget: an obligation whose
        // recovery hangs on every claim (for example an event stream that
        // never yields) would otherwise keep the sweep loop spinning forever,
        // racing every live render in the process.
        failureCounts.set(threadId, (failureCounts.get(threadId) ?? 0) + 1)
        traceLog(options, 'slackbotv2_render_recovery_thread_timeout', undefined, {
          failure_count: failureCounts.get(threadId),
          thread_id: threadId,
          timeout_ms: timeoutMs
        })
        continue
      }
      await releaseLease()
      if (outcome.deferred) deferredCount += 1
    } catch (error) {
      // One thread's corrupt state or failed render must not abort the scan:
      // log it, count it as deferred so a later pass retries it (up to the
      // failure budget above), and keep recovering the remaining threads.
      failureCounts.set(threadId, (failureCounts.get(threadId) ?? 0) + 1)
      deferredCount += 1
      traceLog(options, 'slackbotv2_render_recovery_thread_failed', undefined, {
        error: errorMessage(error),
        failure_count: failureCounts.get(threadId),
        thread_id: threadId
      })
    }
  }
  return deferredCount
}

async function recoverRenderObligation(
  chat: Chat<Record<string, Adapter>, SlackbotV2ThreadState>,
  state: StateAdapter,
  options: SlackbotV2Options,
  threadId: string,
  obligation: SlackbotV2RenderObligation,
  threadState: SlackbotV2ThreadState | null
): Promise<boolean> {
  const trace: SlackbotV2Trace = {
    includeContext: false,
    messageId: obligation.message.id,
    mode: 'execute',
    openStream: true,
    startedAtMs: nowMs(),
    threadId
  }
  const thread = chat.thread(threadId)
  // Re-resolve the owner principal from persisted state so a replayed forward
  // binds/runs under the owner (Part 3d/3f), not api-rs's channel-derived
  // fallback. No fresh Slack-profile/console round-trip on recovery.
  const principalForeignId = recoveryOwnerPrincipalForeignId(obligation, threadState)
  // Replay from the obligation's starting position, not the thread's
  // lastEventId: the failed render may have consumed events (including the
  // terminal result) past which a resumed stream would never see the final
  // answer again. Session events are durable, so a full replay is safe.
  let lastEventId = obligation.afterEventId
  const input: ForwardSessionInput = {
    afterEventId: obligation.afterEventId,
    executionId: obligation.executionId,
    messages: [],
    onEventId: eventId => {
      lastEventId = Math.max(lastEventId, eventId)
    },
    openStream: false,
    ownerSlackUserId: threadState?.owner?.slackUserId,
    principalForeignId,
    threadId,
    trace
  }

  let openedStream: AsyncIterable<SlackbotV2RendererSource>
  try {
    openedStream = await openSessionEventStream(options, input)
  } catch (error) {
    const retryable = isRetryableSessionApiError(error)
    traceLog(options, 'slackbotv2_render_recovery_deferred', trace, {
      error: errorMessage(error),
      last_event_id: lastEventId,
      retryable
    })
    if (retryable) return true
    await renderRecoveredExecutionStream(thread, streamError(error), obligation.message, options, trace)
    await thread.setState({
      activeExecution: false,
      lastEventId,
      renderObligation: null
    })
    await finalizeSourceStatus(options, obligation.sourceStatus, 'failed', trace)
    return false
  }

  let rendered = false
  try {
    await thread.setState({
      activeExecution: true,
      lastEventId
    })
    await renderRecoveredExecutionStream(
      thread,
      streamOpenedSession(input, openedStream),
      obligation.message,
      options,
      trace
    )
    rendered = true
    traceLog(options, 'slackbotv2_render_recovery_complete', trace)
  } catch (error) {
    const answerLost = slackAnswerLost(error)
    if (answerLost === false) {
      // The recovered stream broke only after the final answer became
      // visible; reposting would duplicate it.
      rendered = true
      traceLog(options, 'slackbotv2_render_recovery_failed_answer_visible', trace, {
        error: errorMessage(error)
      })
    } else {
      traceLog(options, 'slackbotv2_render_recovery_render_failed', trace, {
        error: errorMessage(error),
        slack_answer_lost: answerLost ?? 'unknown'
      })
      const replaceMessageId = isSlackStreamSizeLimitError(error)
        ? slackStreamMessageId(error)
        : undefined
      if (isSlackStreamSizeLimitError(error) && !replaceMessageId) {
        // Size-limit failures should be prevented by stream segmentation. If
        // Slack still rejects a stream as too large but does not expose the
        // failed stream message id, do not post a separate duplicate fallback.
        rendered = true
        traceLog(options, 'slackbotv2_render_recovery_failed_size_limit_no_replacement', trace, {
          error: errorMessage(error),
          slack_answer_lost: answerLost ?? 'unknown'
        })
        return false
      }
      const fallback = await renderFallbackFinalAnswer(
        thread,
        options,
        {
          afterEventId: obligation.afterEventId,
          executionId: obligation.executionId,
          threadId
        },
        trace,
        replaceMessageId ? { replaceMessageId } : undefined
      )
      if (!fallback) throw error
      rendered = true
      lastEventId = Math.max(lastEventId, fallback.lastEventId)
    }
  } finally {
    const latest = (await thread.state) ?? {}
    await thread.setState({
      activeExecution: false,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      ...(rendered ? { renderObligation: null } : {})
    })
    if (rendered) {
      await finalizeSourceStatus(options, obligation.sourceStatus, 'done', trace)
    }
    traceLog(options, 'slackbotv2_render_recovery_finalized', trace, {
      obligation_cleared: rendered,
      last_event_id: lastEventId
    })
  }
  return false
}

async function indexRenderObligation(
  state: StateAdapter,
  input: {
    options: SlackbotV2Options
    threadId: string
    trace?: SlackbotV2Trace
  }
): Promise<void> {
  await state.appendToList(RENDER_OBLIGATION_INDEX_KEY, input.threadId, {
    maxLength: RENDER_OBLIGATION_INDEX_MAX_LENGTH,
    ttlMs: RENDER_INDEX_TTL_MS
  })
  traceLog(input.options, 'slackbotv2_render_obligation_indexed', input.trace)
}

async function* streamOpenedSession(
  _input: Pick<ForwardSessionInput, 'threadId' | 'trace'>,
  stream: AsyncIterable<SlackbotV2RendererSource>
): AsyncIterable<SlackbotV2RendererSource> {
  for await (const event of stream) yield event
}

function renderRecoveryLeaseKey(threadId: string): string {
  return `slackbotv2:render:lease:${threadId}`
}

function ownerClaimKey(threadId: string): string {
  return `slackbotv2:owner:claim:${threadId}`
}

/**
 * Claim thread ownership for the first author atomically. Handlers are NOT
 * serialized per thread (onLockConflict:'force'), so two concurrent first
 * messages race here; setIfNotExists (an INSERT ... ON CONFLICT DO NOTHING)
 * lets exactly one win. The winner is the owner; a loser loads the winning
 * claimant from the same key. No TTL — ownership is immutable, so the claim
 * persists for the thread's life (mirrored onto state.owner, which the gate
 * reads). Returns the resolved owner, or undefined if the claim could neither
 * be written nor read back (treat as un-owned: fail closed). Exported for tests.
 */
export async function claimThreadOwner(
  state: StateAdapter,
  threadId: string,
  authorOwner: SlackbotV2ThreadOwner
): Promise<SlackbotV2ThreadOwner | undefined> {
  const won = await state.setIfNotExists(ownerClaimKey(threadId), authorOwner)
  if (won) return authorOwner
  return (await state.get<SlackbotV2ThreadOwner>(ownerClaimKey(threadId))) ?? undefined
}

/**
 * The owner principal the recovery sweep re-forwards under: the obligation's
 * self-sufficient copy first, then the live thread owner (Part 3d/3f). Exported
 * for tests. Returns undefined when neither is set (api-rs falls back to its
 * channel-derived principal).
 */
export function recoveryOwnerPrincipalForeignId(
  obligation: SlackbotV2RenderObligation,
  threadState: SlackbotV2ThreadState | null
): string | undefined {
  return obligation.principalForeignId ?? threadState?.owner?.principalForeignId
}

/**
 * Holds the per-thread render lease for the duration of a live render so the
 * recovery sweep cannot claim the just-indexed obligation and post a
 * duplicate answer (it lease-skips instead). The TTL keeps this crash-safe:
 * if the pod dies mid-render the lease expires and recovery takes over. The
 * lease is refreshed while the render runs because agent turns routinely
 * outlive a single TTL window.
 */
async function acquireRenderLease(
  state: StateAdapter,
  threadId: string
): Promise<() => Promise<void>> {
  const key = renderRecoveryLeaseKey(threadId)
  const token = randomUUID()
  await state.set(key, token, RENDER_RECOVERY_LEASE_TTL_MS)
  const refresh = setInterval(() => {
    void state
      .get<string>(key)
      .then(current =>
        current === token ? state.set(key, token, RENDER_RECOVERY_LEASE_TTL_MS) : undefined
      )
      .catch(() => undefined)
  }, RENDER_LEASE_REFRESH_INTERVAL_MS)
  return async () => {
    clearInterval(refresh)
    try {
      const current = await state.get<string>(key)
      if (current === token) await state.delete(key)
    } catch {
      // Best effort: TTL expiry is the backstop.
    }
  }
}

async function renderExecutionStream(
  thread: Thread,
  stream: AsyncIterable<SlackbotV2RendererSource>,
  message: SlackbotV2ApiMessage,
  options: SlackbotV2Options,
  trace?: SlackbotV2Trace,
  assistantStatusVisible = false
): Promise<void> {
  if (isPlainTextOnlyRequest(message.text)) {
    await renderPlainTextExecutionStream(
      thread,
      stream,
      message,
      options,
      trace,
      assistantStatusVisible
    )
    return
  }
  const titleStartedAtMs = nowMs()
  await setAssistantTitle(thread, titleFromMessage(message.text, options.userName))
  if (!assistantStatusVisible) {
    await setAssistantStatus(thread, options.assistantStatus ?? 'Thinking...')
  }
  traceLog(options, 'slackbotv2_render_slack_metadata_set', trace, {
    assistant_status_already_visible: assistantStatusVisible,
    phase_ms: elapsedMs(titleStartedAtMs)
  })
  try {
    const visibleStream = await streamAfterFirstChunk(
      conflateChatSdkStream(
        slackSafeChatSdkStream(
          codexAppServerToChatSdkStream(
            stream,
            rendererOptions(thread, options)
          )
        )
      )
    )
    if (!visibleStream) return
    // Stream with an explicit recipient (not thread.post) so this works on the
    // synthetic DM run-thread too: a thread addressed via chat.thread(id) has no
    // inbound "current message" for the adapter to derive the recipient from.
    await thread.adapter.stream!(
      thread.id,
      visibleStream,
      {
        recipientTeamId: message.teamId,
        recipientUserId: message.author.userId,
        taskDisplayMode: options.streamTaskDisplayMode ?? 'plan'
      }
    )
  } finally {
    await setAssistantStatus(thread, '')
  }
}

async function renderRecoveredExecutionStream(
  thread: Thread,
  stream: AsyncIterable<SlackbotV2RendererSource>,
  message: SlackbotV2ApiMessage,
  options: SlackbotV2Options,
  trace?: SlackbotV2Trace
): Promise<void> {
  if (isPlainTextOnlyRequest(message.text)) {
    await renderPlainTextExecutionStream(thread, stream, message, options, trace)
    return
  }
  const titleStartedAtMs = nowMs()
  await setAssistantTitle(thread, titleFromMessage(message.text, options.userName))
  await setAssistantStatus(thread, options.assistantStatus ?? 'Thinking...')
  traceLog(options, 'slackbotv2_render_slack_metadata_set', trace, {
    phase_ms: elapsedMs(titleStartedAtMs)
  })
  try {
    const visibleStream = await streamAfterFirstChunk(
      conflateChatSdkStream(
        slackSafeChatSdkStream(
          codexAppServerToChatSdkStream(
            stream,
            rendererOptions(thread, options)
          )
        )
      )
    )
    if (!visibleStream) return
    await thread.adapter.stream!(
      thread.id,
      visibleStream,
      {
        recipientTeamId: message.teamId,
        recipientUserId: message.author.userId,
        taskDisplayMode: options.streamTaskDisplayMode ?? 'plan'
      }
    )
  } finally {
    await setAssistantStatus(thread, '')
  }
}

async function renderPlainTextExecutionStream(
  thread: Thread,
  stream: AsyncIterable<SlackbotV2RendererSource>,
  message: SlackbotV2ApiMessage,
  options: SlackbotV2Options,
  trace?: SlackbotV2Trace,
  assistantStatusVisible = false
): Promise<void> {
  const fallback = new SlackRenderFallback()
  const titleStartedAtMs = nowMs()
  await setAssistantTitle(thread, titleFromMessage(message.text, options.userName))
  if (!assistantStatusVisible) {
    await setAssistantStatus(thread, options.assistantStatus ?? 'Thinking...')
  }
  traceLog(options, 'slackbotv2_render_plain_text_metadata_set', trace, {
    assistant_status_already_visible: assistantStatusVisible,
    phase_ms: elapsedMs(titleStartedAtMs)
  })
  try {
    const chatStream = fallback.collectChatSdk(
      slackSafeChatSdkStream(
        codexAppServerToChatSdkStream(
          fallback.collectSource(stream),
          rendererOptions(thread, options)
        )
      )
    )
    for await (const _chunk of chatStream) {
      void _chunk
    }
    const text = truncateSlackText(
      fallback.text() || 'Execution completed, but no final text was captured.',
      SLACK_FALLBACK_TEXT_MAX_CHARS,
      'Slack final answer'
    )
    traceLog(options, 'slackbotv2_render_plain_text_final', trace, {
      chars: text.length
    })
    await thread.post(text)
  } finally {
    await setAssistantStatus(thread, '')
  }
}

class SlackRenderFallback {
  private markdownText = ''
  private terminalText = ''

  async *collectSource(
    stream: AsyncIterable<SlackbotV2RendererSource>
  ): AsyncIterable<SlackbotV2RendererSource> {
    for await (const event of stream) {
      this.captureTerminalText(event)
      yield event
    }
  }

  async *collectChatSdk(
    stream: AsyncIterable<ChatSDKStreamChunk>
  ): AsyncIterable<ChatSDKStreamChunk> {
    for await (const chunk of stream) {
      if (chunk.type === 'markdown_text') this.markdownText += chunk.text
      yield chunk
    }
  }

  text(): string {
    return (this.terminalText || this.markdownText).trim()
  }

  private captureTerminalText(event: SlackbotV2RendererSource): void {
    if (!event || typeof event !== 'object') return
    const eventKind = String(
      'eventKind' in event ? event.eventKind : 'event' in event ? event.event : ''
    )
    if (
      eventKind !== 'session.execution_completed' &&
      eventKind !== 'session.execution_cancelled' &&
      !isTerminalCodexAppServerEvent(event)
    ) {
      return
    }
    const data = 'data' in event && event.data && typeof event.data === 'object'
      ? event.data
      : event
    const text = terminalResultText(data)
    if (text) this.terminalText = text
  }
}

async function* slackSafeChatSdkStream(
  stream: AsyncIterable<ChatSDKStreamChunk>
): AsyncIterable<ChatSDKStreamChunk> {
  for await (const chunk of stream) {
    yield slackSafeChatSdkChunk(chunk)
  }
}

function slackSafeChatSdkChunk(chunk: ChatSDKStreamChunk): ChatSDKStreamChunk {
  if (chunk.type !== 'task_update') return chunk
  const { output: _output, details, ...safeChunk } = chunk
  void _output
  return {
    ...safeChunk,
    ...(details ? { details: truncateSlackTaskField(details) } : {})
  }
}

function isPlainTextOnlyRequest(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    /\bplain\s+text\s+only\b/.test(normalized)
    || /\bno\s+interactive\s+blocks?\b/.test(normalized)
    || /\bno\s+dashboards?\b/.test(normalized)
  )
}

function truncateSlackTaskField(value: string): string {
  return truncateSlackText(value, SLACK_TASK_DETAILS_MAX_CHARS, 'Slack task details')
}

function truncateSlackText(value: string, maxChars: number, label: string): string {
  if (value.length <= maxChars) return value
  let omitted = value.length - maxChars
  while (true) {
    const suffix = `\n[truncated ${omitted} chars from ${label}]`
    const keep = Math.max(0, maxChars - suffix.length)
    const actualOmitted = value.length - keep
    if (actualOmitted === omitted) return `${value.slice(0, keep).trimEnd()}${suffix}`
    omitted = actualOmitted
  }
}

async function streamAfterFirstChunk(
  stream: AsyncIterable<ChatSDKStreamChunk>
): Promise<AsyncIterable<ChatSDKStreamChunk> | null> {
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) return null

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ChatSDKStreamChunk> {
      yield first.value
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    }
  }
}

function isTerminalCodexAppServerEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const type = (event as { type?: unknown }).type
  return type === 'result' || type === 'turn.done' || type === 'turn.completed'
}

function terminalResultText(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  for (const key of ['result', 'result_text', 'text', 'final_text']) {
    const value = (event as Record<string, unknown>)[key]
    if (typeof value !== 'string') continue
    const resultText = value.trim()
    if (resultText) return resultText
  }
  return ''
}

async function* streamSessionAfterHandoff(
  options: SlackbotV2Options,
  input: ForwardSessionInput
): AsyncIterable<SlackbotV2RendererSource> {
  let stream: AsyncIterable<SlackbotV2RendererSource>
  try {
    stream = await openSessionEventStream(options, input)
  } catch (error) {
    traceLog(options, 'slackbotv2_forward_failed', input.trace, {
      error: errorMessage(error)
    })
    if (isRetryableSessionApiError(error)) throw error
    yield sessionStreamError(error)
    return
  }

  for await (const event of stream) yield event
}

async function* streamError(error: unknown): AsyncIterable<SlackbotV2RendererSource> {
  yield sessionStreamError(error)
}

function backgroundWaitUntil(promise: Promise<unknown>): void {
  const context = requestContext.getStore()
  if (context) {
    context.waitUntil(promise)
    return
  }
  void promise.catch(() => undefined)
}

function shouldAwaitSlackHandoff(rawBody: string): boolean {
  try {
    const payload = JSON.parse(rawBody) as { event?: { type?: unknown }; type?: unknown }
    const eventType = payload.event?.type
    return payload.type === 'event_callback' && (eventType === 'message' || eventType === 'app_mention')
  } catch {
    return false
  }
}

/** The thread-owner identity for a message: its Slack author + team, or undefined. */
function ownerIdentityFromMessage(message: SlackbotV2ApiMessage): SlackbotV2ThreadOwner | undefined {
  const slackUserId = stringValue(message.author.userId)
  if (!slackUserId) return undefined
  const teamId = stringValue(message.teamId)
  return teamId ? { slackUserId, teamId } : { slackUserId }
}

/** The persisted mention -> DM run-thread mapping, used to make spawns idempotent. */
type PersistedDmRun = {
  dmChannel: string
  runThreadId: string
  sourceStatus?: SlackbotV2SourceStatusRef
}

/** State key for a mention's spawned DM run (NEW_MULTITENANT idempotency). */
function dmRunStateKey(owner: SlackbotV2ThreadOwner, messageId: string): string {
  return `slackbotv2:dmrun:${owner.teamId ?? ''}:${messageId}`
}

/**
 * Spawn a fresh private run in the mentioner's 1:1 DM and leave a dynamic status
 * pointer in the source thread (NEW_MULTITENANT). The owner is the mention author
 * (per request, NOT a thread-wide claim); the session is keyed by the DM
 * run-thread and runs under the owner's principal; the source-thread history is
 * forwarded into the session exactly as before.
 *
 * Idempotent per mention: a Slack webhook retry (after a retryable handoff error)
 * reuses the already-spawned DM run-thread instead of opening a duplicate.
 */
async function startDmRunThread(
  chat: Chat<Record<string, Adapter>, SlackbotV2ThreadState>,
  sourceThread: Thread<SlackbotV2ThreadState>,
  message: ChatMessage,
  input: { options: SlackbotV2Options; state: StateAdapter }
): Promise<void> {
  const { options, state } = input
  const trace: SlackbotV2Trace = {
    includeContext: true,
    messageId: message.id,
    mode: 'execute',
    openStream: true,
    startedAtMs: nowMs(),
    threadId: sourceThread.id
  }

  const serialized = await serializeMessage(message)
  const owner = ownerIdentityFromMessage(serialized)
  if (!owner) {
    traceLog(options, 'slackbotv2_dm_run_owner_unresolved', trace, { message_id: message.id })
    return
  }

  // Reuse an already-spawned run on reprocess (Slack retry): re-drive the session
  // on the existing DM run-thread instead of opening a duplicate DM + status.
  const runStateKey = dmRunStateKey(owner, message.id)
  const existingRun = await state.get<PersistedDmRun>(runStateKey)
  if (existingRun) {
    traceLog(options, 'slackbotv2_dm_run_reused', trace, {
      owner_user_id: owner.slackUserId,
      run_thread_id: existingRun.runThreadId
    })
    await syncThreadMessageToSession(chat.thread(existingRun.runThreadId), message, {
      mode: 'execute',
      options,
      runContext: { sourceStatus: existingRun.sourceStatus },
      state
    })
    return
  }

  // Pre-gate on the owner's provider key BEFORE opening a DM or posting anything:
  // fail closed (never a shared key) and prompt onboarding in the source thread.
  // The principal itself is threaded into the session by the run-thread's own
  // forward (syncThreadMessageToSession resolves it against the DM thread owner).
  if (isOwnerPrincipalConfigured(options)) {
    const resolved = await resolveOwnerPrincipal(options, owner)
    if (!resolved || !resolved.hasProviderKey) {
      traceLog(options, 'slackbotv2_dm_run_no_provider_key', trace, {
        has_provider_key: resolved?.hasProviderKey === true,
        owner_user_id: owner.slackUserId,
        resolved: Boolean(resolved)
      })
      await postOwnerOnboardingPrompt(sourceThread, owner, options)
      return
    }
  }

  // Open the owner's 1:1 DM — the private run surface. Fail closed with a notice.
  const dmChannel = await openOwnerDm(options, owner.slackUserId)
  if (!dmChannel) {
    traceLog(options, 'slackbotv2_dm_run_open_failed', trace, { owner_user_id: owner.slackUserId })
    await postDmOpenFailureNotice(sourceThread, owner, options)
    return
  }

  // Post the run-thread root in the DM: a task summary + a link back to the source.
  const sourceLink = await sourceThreadPermalink(options, message)
  const taskTitle = titleFromMessage(serialized.text, options.userName)
  const root = await sendSlackMessage(options, {
    channel: dmChannel,
    text: runRootText({ taskTitle, sourceLink })
  })
  if (!root) {
    traceLog(options, 'slackbotv2_dm_run_root_failed', trace, { owner_user_id: owner.slackUserId })
    await postDmOpenFailureNotice(sourceThread, owner, options)
    return
  }
  const runThreadId = dmRunThreadId(dmChannel, root.ts)
  const runPermalink = await fetchSlackPermalink(options, dmChannel, root.ts)
  const ownerMention = `<@${owner.slackUserId}>`

  // Subscribe the DM run-thread so the owner's later in-thread replies iterate.
  const runThread = chat.thread(runThreadId)
  await runThread.subscribe()

  // Post the dynamic status pointer in the source thread, linking to the DM run.
  let sourceStatus: SlackbotV2SourceStatusRef | undefined
  const statusTarget = slackThreadTarget(message)
  if (statusTarget) {
    const posted = await sendSlackMessage(options, {
      channel: statusTarget.channel,
      threadTs: statusTarget.threadTs,
      text: runStatusText('running', { ownerMention, runPermalink })
    })
    if (posted) {
      sourceStatus = {
        channel: posted.channel,
        ts: posted.ts,
        ownerMention,
        permalink: runPermalink
      }
    }
  }

  // Persist the mention -> run mapping BEFORE driving the session, so a Slack retry
  // after a retryable handoff error reuses this run-thread rather than spawning a
  // duplicate (the reuse branch above).
  await state.set(runStateKey, { dmChannel, runThreadId, sourceStatus }, DM_RUN_STATE_TTL_MS)

  traceLog(options, 'slackbotv2_dm_run_started', trace, {
    dm_channel: dmChannel,
    owner_user_id: owner.slackUserId,
    run_thread_id: runThreadId
  })

  // Drive the first execution keyed by the DM run-thread: the session is keyed by
  // the DM, context is forwarded from the SOURCE thread (the mention's own raw),
  // and the agent stream renders into the DM.
  await syncThreadMessageToSession(runThread, message, {
    mode: 'execute',
    options,
    state,
    runContext: { sourceStatus }
  })
}

/**
 * Finalize the source-thread status pointer (NEW_MULTITENANT) to its terminal
 * state. No-op when there is no pointer (run-in-place DM). Best-effort: a failed
 * Slack update must never break finalize or recovery.
 */
async function finalizeSourceStatus(
  options: SlackbotV2Options,
  sourceStatus: SlackbotV2SourceStatusRef | undefined,
  state: RunStatusState,
  trace?: SlackbotV2Trace
): Promise<void> {
  if (!sourceStatus) return
  const ok = await editSlackMessage(
    options,
    sourceStatus,
    runStatusText(state, {
      ownerMention: sourceStatus.ownerMention,
      runPermalink: sourceStatus.permalink
    })
  )
  if (!ok) {
    traceLog(options, 'slackbotv2_source_status_finalize_failed', trace, {
      channel: sourceStatus.channel,
      state,
      ts: sourceStatus.ts
    })
  }
}

/** The source thread to anchor the status pointer in: channel + thread root ts. */
function slackThreadTarget(message: ChatMessage): { channel: string; threadTs: string } | null {
  const raw = slackRawRecord(message)
  const channel = stringField(raw.channel)
  if (!channel) return null
  const ts = stringField(raw.ts) || message.id
  const threadTs = stringField(raw.thread_ts) || ts
  return { channel, threadTs }
}

/** Permalink to the triggering mention, shown in the DM run-thread root message. */
async function sourceThreadPermalink(
  options: SlackbotV2Options,
  message: ChatMessage
): Promise<string | undefined> {
  const raw = slackRawRecord(message)
  const channel = stringField(raw.channel)
  const ts = stringField(raw.ts) || message.id
  if (!channel || !ts) return undefined
  return fetchSlackPermalink(options, channel, ts)
}

/**
 * Tell the owner (in the source thread, where they are) to register a provider
 * key, when their run was skipped for lack of one. The run already failed closed
 * (never a shared key); this is the user-facing nudge. Best-effort post.
 */
async function postOwnerOnboardingPrompt(
  thread: Thread<SlackbotV2ThreadState>,
  owner: SlackbotV2ThreadOwner,
  options: SlackbotV2Options
): Promise<void> {
  const logger = options.logger ?? noopLogger
  const url = options.consoleUrl
    ? `${options.consoleUrl.replace(/\/+$/, '')}/console/provider_keys`
    : undefined
  const link = url ? `<${url}|the Centaur console>` : 'the Centaur console'
  logger.warn('slackbotv2_owner_onboarding_prompt', {
    owner_user_id: owner.slackUserId,
    thread_id: thread.id
  })
  await safeThreadPost(
    thread,
    options,
    `<@${owner.slackUserId}> register your provider API key at ${link} to run the agent under your own key.`,
    'slackbotv2_owner_onboarding_post_failed'
  )
}

/** Notify (in the source thread) that the bot could not open the owner's DM. */
async function postDmOpenFailureNotice(
  thread: Thread<SlackbotV2ThreadState>,
  owner: SlackbotV2ThreadOwner,
  options: SlackbotV2Options
): Promise<void> {
  await safeThreadPost(
    thread,
    options,
    `<@${owner.slackUserId}> I couldn't open a DM to start your private run. `
      + 'Open a direct message with me (check that DMs are enabled), then mention me again.',
    'slackbotv2_dm_open_notice_post_failed'
  )
}

/** Post into a thread, swallowing failures (prompts/notices are best-effort). */
async function safeThreadPost(
  thread: Thread<SlackbotV2ThreadState>,
  options: SlackbotV2Options,
  text: string,
  failureEvent: string
): Promise<void> {
  try {
    await thread.post(text)
  } catch (error) {
    traceLog(options, failureEvent, undefined, { error: errorMessage(error) })
  }
}

function isSlackThreadReply(message: ChatMessage): boolean {
  const raw = message.raw
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const item = raw as Record<string, unknown>
  const threadTs = typeof item.thread_ts === 'string' ? item.thread_ts : ''
  const ts = typeof item.ts === 'string' ? item.ts : message.id
  return Boolean(threadTs && ts && threadTs !== ts)
}

async function collectSlackThreadContext(
  options: SlackbotV2Options,
  currentMessage: ChatMessage
): Promise<SlackbotV2ApiMessage[]> {
  const raw = slackRawRecord(currentMessage)
  const channel = stringField(raw.channel)
  const threadTs = stringField(raw.thread_ts)
  const currentTs = stringField(raw.ts) || currentMessage.id
  if (!channel || !threadTs) return [await serializeMessage(currentMessage)]

  const messages: SlackbotV2ApiMessage[] = []
  let cursor: string | undefined
  do {
    const response = await fetchSlackThreadReplies({
      apiUrl: options.slackApiUrl,
      channel,
      cursor,
      limit: 200,
      token: options.botToken,
      ts: threadTs
    })
    const slackMessages = Array.isArray(response.messages) ? response.messages : []
    for (const rawMessage of slackMessages) {
      const message = rawMessage as Record<string, unknown>
      const messageTs = stringField(message.ts)
      if (!messageTs || compareSlackTs(messageTs, currentTs) > 0) continue
      if (isSelfSlackBotMessage(options, message)) continue
      messages.push(await slackApiMessageFromSlack(options, message, currentMessage))
    }
    cursor = response.nextCursor
  } while (cursor)

  const currentIndex = messages.findIndex(message => message.id === currentMessage.id)
  const serializedCurrent = await serializeMessage(currentMessage)
  if (currentIndex >= 0) {
    messages[currentIndex] = serializedCurrent
  } else {
    messages.push(serializedCurrent)
  }
  return messages
}

async function slackApiMessageFromSlack(
  options: SlackbotV2Options,
  message: Record<string, unknown>,
  currentMessage: ChatMessage
): Promise<SlackbotV2ApiMessage> {
  const rawCurrent = slackRawRecord(currentMessage)
  const id = stringField(message.ts) || randomUUID()
  const actorId = slackActorId(message)
  const isBot = Boolean(message.bot_id || message.bot_profile)
  return {
    attachments: await slackApiAttachmentsFromFiles(options, message, rawCurrent),
    author: {
      fullName: actorId,
      isBot,
      isMe: Boolean(actorId && actorId === currentMessage.author.userId),
      userId: actorId,
      userName: actorId
    },
    id,
    isMention: id === currentMessage.id ? currentMessage.isMention === true : false,
    raw: message,
    teamId:
      stringField(message.team)
      || stringField(message.team_id)
      || stringField(rawCurrent.team)
      || stringField(rawCurrent.team_id),
    text: normalizeSlackText(stringField(message.text)),
    threadId: currentMessage.threadId,
    timestamp: slackTimestampToIso(id)
  }
}

async function slackApiAttachmentsFromFiles(
  options: SlackbotV2Options,
  message: Record<string, unknown>,
  rawCurrent: Record<string, unknown>
): Promise<SlackbotV2ApiAttachment[]> {
  const files = slackFiles(message)
  if (files.length === 0) return []
  const teamId =
    stringField(message.team)
    || stringField(message.team_id)
    || stringField(rawCurrent.team)
    || stringField(rawCurrent.team_id)
  const attachments: SlackbotV2ApiAttachment[] = []
  for (const file of files.slice(0, MAX_SLACK_MESSAGE_ATTACHMENTS)) {
    attachments.push(await serializeAttachment(slackFileAttachment(options, file, teamId)))
  }
  if (files.length > MAX_SLACK_MESSAGE_ATTACHMENTS) {
    attachments.push({
      fetchError:
        `only the first ${MAX_SLACK_MESSAGE_ATTACHMENTS} Slack message attachments were fetched`,
      name: 'additional Slack thread attachments',
      type: 'file'
    })
  }
  return attachments
}

function slackFiles(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.files)
    ? (message.files.filter(file =>
        file && typeof file === 'object' && !Array.isArray(file)
      ) as Record<string, unknown>[])
    : []
}

function slackFileAttachment(
  options: SlackbotV2Options,
  file: Record<string, unknown>,
  teamId: string
): Attachment {
  const url = stringField(file.url_private_download) || stringField(file.url_private)
  const mimeType = stringField(file.mimetype)
  const fetchMetadata: Record<string, string> = {}
  if (url) fetchMetadata.url = url
  if (teamId) fetchMetadata.teamId = teamId
  return {
    fetchData: url ? () => fetchSlackFile(options, url) : undefined,
    fetchMetadata: Object.keys(fetchMetadata).length > 0 ? fetchMetadata : undefined,
    height: numberField(file.original_h),
    mimeType,
    name: stringField(file.name) || stringField(file.title) || stringField(file.id),
    size: numberField(file.size),
    type: slackFileAttachmentType(mimeType),
    url,
    width: numberField(file.original_w)
  }
}

async function fetchSlackFile(options: SlackbotV2Options, url: string): Promise<Buffer> {
  const fetchFn = options.fetch ?? fetch
  const response = await fetchFn(url, {
    headers: { authorization: `Bearer ${options.botToken}` }
  })
  if (!response.ok) {
    throw new Error(`failed to fetch Slack file: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function slackFileAttachmentType(mimeType: string): Attachment['type'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'file'
}

function slackRawRecord(message: ChatMessage): Record<string, unknown> {
  return message.raw && typeof message.raw === 'object' && !Array.isArray(message.raw)
    ? (message.raw as Record<string, unknown>)
    : {}
}

function slackActorId(message: Record<string, unknown>): string {
  const profile = message.bot_profile
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const userId = stringField((profile as Record<string, unknown>).user_id)
    if (userId) return userId
  }
  return stringField(message.user) || stringField(message.bot_id)
}

function isSelfSlackBotMessage(
  options: SlackbotV2Options,
  message: Record<string, unknown>
): boolean {
  const botUserId = options.botUserId
  if (!botUserId) return false
  if (stringField(message.user) === botUserId) return true
  const profile = message.bot_profile
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    return stringField((profile as Record<string, unknown>).user_id) === botUserId
  }
  return false
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compareSlackTs(a: string, b: string): number {
  const left = Number(a)
  const right = Number(b)
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right
  return a.localeCompare(b)
}

function slackTimestampToIso(ts: string): string {
  const seconds = Number(ts)
  return Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString()
}

function normalizeSlackText(input: string): string {
  return input
    .replace(/<([a-z]+:\/\/[^>|]+)\|([^>]+)>/gi, '$2 ($1)')
    .replace(/<([a-z]+:\/\/[^>]+)>/gi, '$1')
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
    .replace(/<#([A-Z0-9]+)>/g, '#$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<!subteam\^([A-Z0-9]+)\|([^>]+)>/g, '@$2')
    .replace(/<!(channel|here|everyone)>/g, '@$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function rendererOptions(thread: Thread, options: SlackbotV2Options): CodexAppServerToChatStreamOptions {
  const mapper = options.mapper
  return {
    ...mapper,
    async onRendererEvent(event: RendererEvent) {
      await mapper?.onRendererEvent?.(event)
      if (event.type === 'renderer.title.update') {
        await setAssistantTitle(thread, event.title)
      }
    }
  }
}

/**
 * Renderer options for the final-answer fallback drain: no Slack side effects
 * (no assistant title updates) and renderer hooks must not be able to fail
 * the delivery.
 */
function fallbackRendererOptions(options: SlackbotV2Options): CodexAppServerToChatStreamOptions {
  const mapper = options.mapper
  return {
    ...mapper,
    async onRendererEvent(event: RendererEvent) {
      try {
        await mapper?.onRendererEvent?.(event)
      } catch {
        // Fallback delivery must not depend on renderer side-effect hooks.
      }
    }
  }
}

function renderRetryDelayMs(attempt: number): number {
  return Math.min(RENDER_RETRY_INITIAL_DELAY_MS * 2 ** attempt, RENDER_RETRY_MAX_DELAY_MS)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function setInitialAssistantStatus(
  thread: Thread,
  options: SlackbotV2Options,
  trace?: SlackbotV2Trace
): Promise<boolean> {
  const startedAtMs = nowMs()
  const visible = await setAssistantStatus(thread, options.assistantStatus ?? 'Thinking...')
  traceLog(options, 'slackbotv2_forward_initial_status_set', trace, {
    phase_ms: elapsedMs(startedAtMs),
    visible
  })
  return visible
}

async function setAssistantStatus(thread: Thread, status: string): Promise<boolean> {
  const target = slackAssistantTarget(thread)
  const adapter = thread.adapter as SlackAssistantAdapter
  if (!target || !adapter.setAssistantStatus) return false
  return await ignoreAssistantError(() =>
    adapter.setAssistantStatus!(
      target.channel,
      target.threadTs,
      status,
      status ? [status] : undefined
    )
  )
}

async function setAssistantTitle(thread: Thread, title: string | undefined): Promise<void> {
  const normalized = title?.trim()
  if (!normalized) return
  const target = slackAssistantTarget(thread)
  const adapter = thread.adapter as SlackAssistantAdapter
  if (!target || !adapter.setAssistantTitle) return
  await ignoreAssistantError(() =>
    adapter.setAssistantTitle!(target.channel, target.threadTs, clipOneLine(normalized, 80))
  )
}

async function ignoreAssistantError(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch {
    // Assistant status/title are Slack UI polish. Rendering should continue if unsupported.
    return false
  }
}

function slackAssistantTarget(thread: Thread): { channel: string; threadTs: string } | null {
  const parts = thread.id.split(':')
  if (parts[0] !== 'slack' || !parts[1] || !parts[2]) return null
  return { channel: parts[1], threadTs: parts[2] }
}

function titleFromMessage(text: string, userName = 'centaur'): string {
  const mentionless = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '')
    .replace(new RegExp(`^\\s*@?${escapeRegExp(userName)}\\b[:,]?\\s*`, 'i'), '')
    .replace(/^@\S+\s+/, '')
    .trim()
  return clipOneLine(mentionless || 'Centaur task', 80)
}

function clipOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}...`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function waitUntil(c: { executionCtx: WaitUntilContext }, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    void promise.catch(() => undefined)
  }
}
