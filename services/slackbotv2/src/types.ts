import type { RustSessionStreamEvent } from '@centaur/harness-events'
import type { CodexAppServerToChatStreamOptions } from '@centaur/rendering'
import type { Attachment, Chat, Logger, StateAdapter } from 'chat'
import type { Hono } from 'hono'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue | undefined }

export type SlackbotV2ApiAuthor = {
  fullName: string
  isBot: boolean | 'unknown'
  isMe: boolean
  userId: string
  userName: string
}

export type SlackbotV2ApiAttachment = {
  dataBase64?: string
  dataBase64Omitted?: string
  fetchError?: string
  fetchMetadata?: Record<string, string>
  height?: number
  mimeType?: string
  name?: string
  size?: number
  type: Attachment['type']
  url?: string
  width?: number
}

export type SlackbotV2ApiMessage = {
  attachments: SlackbotV2ApiAttachment[]
  author: SlackbotV2ApiAuthor
  id: string
  isMention: boolean
  raw: unknown
  teamId: string
  text: string
  threadId: string
  timestamp: string
}

export type SlackbotV2SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export type SlackbotV2SessionMessage = {
  client_message_id?: string
  metadata: JsonObject
  parts: JsonValue[]
  role: SlackbotV2SessionMessageRole
}

export type SlackbotV2AppendMessagesRequest = {
  messages: SlackbotV2SessionMessage[]
}

export type SlackbotV2CreateSessionRequest = {
  harness_type: string
  metadata: JsonObject
  /** 'restart': switch the thread to harness_type if it's pinned to another harness. */
  on_harness_conflict?: 'reject' | 'restart'
}

export type SlackbotV2ExecuteSessionRequest = {
  idempotency_key?: string
  idle_timeout_ms?: number
  input_lines: string[]
  max_duration_ms?: number
  metadata: JsonObject
}

export type SlackbotV2ExecuteSessionResponse = {
  execution_id: string
  ok: boolean
  status: string
  thread_key: string
}

export type SlackbotV2Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type SlackbotV2Options = {
  allowedExternalTeamIds?: readonly string[]
  apiKey?: string
  apiUrl: string
  assistantStatus?: string
  botToken: string
  botUserId?: string
  /**
   * Harness for new threads when no --claude/--amp/--codex flag is given
   * (HarnessType wire value: codex | amp | claudecode). Defaults to codex.
   */
  defaultHarnessType?: string
  fetch?: SlackbotV2Fetch
  idleTimeoutMs?: number
  logger?: Logger
  maxDurationMs?: number
  postgresUrl?: string
  recoverRenderObligationsOnStart?: boolean
  /** Per-thread deadline for one recovery attempt during the startup scan. */
  renderRecoveryThreadTimeoutMs?: number
  /** centaur-console base URL, for resolving a thread owner -> their principal. */
  consoleUrl?: string
  /** Privileged console ApiKey the bot uses to call the resolve endpoint. */
  consoleToken?: string
  signingSecret: string
  slackApiUrl?: string
  state?: StateAdapter
  stateKeyPrefix?: string
  streamTaskDisplayMode?: 'plan' | 'timeline'
  triggerBotAllowlist?: readonly string[]
  userName?: string
  mapper?: CodexAppServerToChatStreamOptions
}

export type SlackbotV2 = {
  app: Hono
  chat: Chat
}

/**
 * The owner of a Slack thread: the first author, claimed once and immutable (no
 * transfer/fork). The bot reacts only to the owner's messages, and the thread's
 * session runs under the owner's provider key. `principalForeignId` caches the
 * console resolution so the startup recovery sweep can re-bind without a fresh
 * Slack profile + console round-trip.
 */
export type SlackbotV2ThreadOwner = {
  slackUserId: string
  teamId?: string
  principalForeignId?: string
}

export type SlackbotV2ThreadState = {
  activeExecution?: boolean
  executedMessageIds?: string[]
  forwardedMessageIds?: string[]
  historyForwarded?: boolean
  lastEventId?: number
  owner?: SlackbotV2ThreadOwner
  renderObligation?: SlackbotV2RenderObligation | null
}

export type SlackbotV2RenderObligation = {
  afterEventId: number
  executionId: string
  message: SlackbotV2ApiMessage
  /**
   * The owner's principal foreign_id at the time the obligation was created, so
   * the startup recovery sweep re-forwards under the owner principal rather than
   * api-rs's channel-derived fallback (MULTITENANT Part 3d/3f). Self-sufficient
   * copy; the sweep falls back to the live `state.owner.principalForeignId`.
   */
  principalForeignId?: string
  /**
   * The source-thread status pointer for a DM run-thread (NEW_MULTITENANT), so
   * the recovery sweep can finalize it (✅/❌) after a crash instead of leaving it
   * stuck on "Running…". Absent for a run-in-place DM mention (no pointer).
   */
  sourceStatus?: SlackbotV2SourceStatusRef
}

/**
 * A handle to the dynamic status message the bot maintains in the source thread,
 * pointing at the owner's DM run-thread (NEW_MULTITENANT). `permalink`/`ownerMention`
 * are carried so a finalize (`chat.update`) can re-render the pointer text without
 * another Slack round-trip.
 */
export type SlackbotV2SourceStatusRef = {
  channel: string
  ts: string
  ownerMention?: string
  permalink?: string
}

/**
 * Extra context for a session run that lives in a DM run-thread distinct from the
 * triggering message's own thread (NEW_MULTITENANT). Present only on the first
 * execution of a freshly spawned DM run; absent for in-DM iteration and the
 * run-in-place path.
 */
export type SlackbotV2RunContext = {
  sourceStatus?: SlackbotV2SourceStatusRef
}

export type SlackbotV2MessageMode = 'append' | 'execute'

export type SlackbotV2RendererSource = RustSessionStreamEvent | JsonObject

export type SlackbotV2Trace = {
  includeContext: boolean
  messageId: string
  mode: SlackbotV2MessageMode
  openStream: boolean
  startedAtMs: number
  threadId: string
}

export type ForwardSessionInput = {
  afterEventId: number
  executeContextMessages?: SlackbotV2ApiMessage[]
  /**
   * Prepended to the execute message content as a text part. Set when a
   * harness restart discards the previous harness's conversation state so the
   * new harness still sees the thread history.
   */
  contextPreamble?: string
  executionId?: string
  executeMessage?: SlackbotV2ApiMessage
  /** Harness override parsed from message flags (--claude/--amp/--codex). */
  harnessType?: string
  messages: SlackbotV2ApiMessage[]
  /** Per-turn model override parsed from message flags (--model/--opus/...). */
  model?: string
  /** Per-turn reasoning effort parsed from the `-rsn` flag (codex only). */
  reasoning?: string
  onEventId(eventId: number): void
  openStream: boolean
  /**
   * The immutable thread owner's Slack user id, used to label thread context as
   * owner-vs-untrusted. Anchored to the owner (not the triggering message
   * author) so an empty author can't mislabel the owner's own messages as
   * untrusted (MULTITENANT Part 3g). The gate guarantees they match on the live
   * path; absent on the recovery replay (no fresh context is collected there).
   */
  ownerSlackUserId?: string
  /**
   * The thread owner's personal principal foreign_id, threaded into the session
   * create/execute metadata so api-rs runs the session under the owner's
   * provider key (MULTITENANT Part 2/3). Absent when per-owner resolution is not
   * configured, in which case api-rs falls back to its channel-derived principal.
   */
  principalForeignId?: string
  threadId: string
  trace?: SlackbotV2Trace
}
