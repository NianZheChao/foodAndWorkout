/**
 * OpenAI 兼容的 Chat Completions 客户端（只支持这一种协议，§6.1）。
 *
 * 这里只管**一次**请求：超时、错误分类、token 估算。重试、降级、校验与落库在 `run.ts`，
 * 这样重试策略集中在一处，也方便单测注入 fetch。
 */

import { LlmError } from './errors'
import { estimateTokens } from './text'

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type ChatContent = string | ChatContentPart[]

export interface ChatMessage {
  role: ChatRole
  content: ChatContent
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  maxOutputTokens: number
  /** 固定 0.2：结构化输出需要稳定，不开放给用户改（§6.1） */
  temperature?: number
  jsonResponse?: boolean
  timeoutMs?: number
}

export interface ChatResult {
  text: string
  model: string
  durationMs: number
  promptTokensEst: number
  completionTokensEst: number
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface ClientDeps {
  fetchImpl?: typeof fetch
  now?: () => number
}

/** 用户可能填 `https://host/v1`、`https://host/v1/` 或整条 `.../chat/completions`，统一归一为前者。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '')
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`
}

function messagesToText(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === 'string') return message.content
      return message.content
        .map((part) => (part.type === 'text' ? part.text : '[image]'))
        .join('\n')
    })
    .join('\n')
}

/** 图片 token 粗估：各家口径不同，按 85 tokens/张保守计（§6.9 的「发送前提示成本」用它）。 */
export const IMAGE_TOKEN_ESTIMATE = 85

export function countImages(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').length : 0),
    0
  )
}

function hasImagePart(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim() !== '') ?? ''
  return line.trim().slice(0, 200)
}

function classifyHttpError(status: number, body: string, imageRequest: boolean): LlmError {
  const lower = body.toLowerCase()
  if (status === 401 || status === 403) {
    return new LlmError('auth', '接口拒绝了这个 token（401/403），请检查 token 与权限', { status, detail: body })
  }
  if (status === 429) {
    return new LlmError('rate-limit', '被限流了（429），稍后再试', { status, retriable: true, detail: body })
  }
  if (status >= 500) {
    return new LlmError('server', `模型服务出错（${status}）`, { status, retriable: true, detail: body })
  }
  if (status === 404) {
    return new LlmError('bad-request', '接口地址不对（404）：检查 baseUrl 是否少了 /v1', { status, detail: body })
  }
  if (status === 400) {
    if (imageRequest && /image|vision|multimodal/.test(lower)) {
      return new LlmError('unsupported-image', '当前模型不支持图片输入', { status, detail: body })
    }
    if (/response_format|json_object|json mode/.test(lower)) {
      return new LlmError('unsupported-param', '接口不支持 response_format=json_object', { status, detail: body })
    }
    return new LlmError('bad-request', `请求被拒绝（400）：${firstLine(body)}`, { status, detail: body })
  }
  return new LlmError('http', `接口返回 ${status}：${firstLine(body)}`, { status, detail: body })
}

/** 同时最多 1 个在途请求，避免批量补全打爆配额（FR-1310）。 */
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job)
  chain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function buildBody(request: ChatRequest, jsonResponse: boolean): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxOutputTokens,
    ...(jsonResponse ? { response_format: { type: 'json_object' } } : {})
  })
}

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
      .join('')
  }
  return ''
}

/** 发一次请求。失败一律抛 LlmError，调用方按 kind 决定重试 / 入队 / 提示。 */
export function chatCompletion(request: ChatRequest, deps: ClientDeps = {}): Promise<ChatResult> {
  return serialize(() => requestOnce(request, deps))
}

async function requestOnce(request: ChatRequest, deps: ClientDeps): Promise<ChatResult> {
  if (!normalizeBaseUrl(request.baseUrl) || !request.apiKey.trim() || !request.model.trim()) {
    throw new LlmError('not-configured', '还没有配置模型接口（设置 → 模型设置）')
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new LlmError('network', '当前环境没有可用的 fetch')

  const now = deps.now ?? Date.now
  const startedAt = now()
  const timeoutMs = request.timeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetchImpl(chatCompletionsUrl(request.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.apiKey}` },
      body: buildBody(request, request.jsonResponse === true),
      signal: controller.signal
    })
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new LlmError('timeout', `请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回`, { retriable: true })
    }
    throw new LlmError('network', '网络请求失败：检查网络与接口地址', {
      retriable: true,
      detail: cause instanceof Error ? cause.message : String(cause)
    })
  } finally {
    clearTimeout(timer)
  }

  const rawText = await response.text()
  if (!response.ok) throw classifyHttpError(response.status, rawText, hasImagePart(request.messages))

  let payload: unknown
  try {
    payload = JSON.parse(rawText)
  } catch {
    throw new LlmError('bad-json', '接口返回的不是 JSON', { detail: rawText.slice(0, 200) })
  }

  const text = extractContent(payload)
  if (!text.trim()) {
    const apiError = (payload as { error?: { message?: string } }).error?.message
    if (apiError) throw new LlmError('http', `接口返回了错误：${firstLine(apiError)}`, { detail: apiError })
    throw new LlmError('empty-response', '接口返回了空内容', { detail: rawText.slice(0, 200) })
  }

  const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
  return {
    text,
    model: (payload as { model?: string }).model ?? request.model,
    durationMs: now() - startedAt,
    promptTokensEst: estimateTokens(messagesToText(request.messages)) + countImages(request.messages) * IMAGE_TOKEN_ESTIMATE,
    completionTokensEst: estimateTokens(text),
    usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } : undefined
  }
}
