/**
 * 模型任务的执行入口（§6.2 / §6.8）。
 *
 * 流水线：本地构造最小 payload → 缓存由调用方先行判断 → 请求 → 剥离包裹 → JSON.parse
 * → Zod 校验 → （失败则只附错误摘要重试一次）→ 返回候选结果。
 * **业务校验（范围 / 自洽 / 门禁）在 application 层做**，因为那一步需要读本地库。
 */

import { chatCompletion, type ChatContentPart, type ChatMessage, type ClientDeps } from './client'
import { toLlmError, type LlmErrorKind } from './errors'
import { parseJsonFromModel } from './text'
import { outputLimitOf, type LlmTask } from './types'
import { calibrationReviewTask } from './tasks/calibration'
import { coachDailyTask } from './tasks/coach'
import { foodResolveTask } from './tasks/foodResolve'
import { logParseTask } from './tasks/logParse'
import { planMealTask, planTrainingTask } from './tasks/plan'
import { reportMonthlyTask, reportWeeklyTask } from './tasks/report'
import { logLlmCall } from '@/data/repositories/llmLogs'
import { getModelConfig, isModelConfigured, saveModelConfig } from '@/data/repositories/modelConfig'
import type { ModelConfigRecord } from '@/domain/types'

export const TASKS = {
  'calibration.review': calibrationReviewTask,
  'coach.daily': coachDailyTask,
  'food.resolve': foodResolveTask,
  'log.parse': logParseTask,
  'plan.meal': planMealTask,
  'plan.training': planTrainingTask,
  'report.weekly': reportWeeklyTask,
  'report.monthly': reportMonthlyTask
} as const

export type TaskId = keyof typeof TASKS

export interface RunSuccess<Out> {
  ok: true
  value: Out
  model: string
  durationMs: number
}

export interface RunFailure {
  ok: false
  kind: LlmErrorKind
  message: string
  /** 网络类失败可以入队稍后重试；结构与参数类失败只能让用户处理 */
  retriable: boolean
  raw?: string
  validationError?: string
}

export type RunResult<Out> = RunSuccess<Out> | RunFailure

export interface RunOptions {
  /** 显式传配置（测试用）；缺省从 IndexedDB 读 */
  config?: ModelConfigRecord
  deps?: ClientDeps
  /** 退避基数，默认 1000ms（1s → 2s） */
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** 关闭日志写入（测试里减少噪声） */
  skipLog?: boolean
  /** 附加在 user 消息里的图片（data URL）；与文字同一条 user message（§6.11） */
  extraUserParts?: ChatContentPart[]
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.map((part) => String(part)).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
    .slice(0, 400)
}

async function logCall(
  task: { id: string; version: number },
  config: ModelConfigRecord,
  options: RunOptions,
  payload: { promptTokensEst: number; completionTokensEst: number; durationMs: number; status: 'ok' | 'error'; errorKind?: string }
): Promise<void> {
  if (options.skipLog) return
  try {
    await logLlmCall({
      taskId: task.id,
      taskVersion: task.version,
      model: config.model,
      durationMs: payload.durationMs,
      promptTokensEst: payload.promptTokensEst,
      completionTokensEst: payload.completionTokensEst,
      status: payload.status,
      errorKind: payload.errorKind
    })
  } catch {
    // 日志写不进去不能影响主链路
  }
}

export async function runTask<In, Out>(
  task: LlmTask<In, Out>,
  input: In,
  options: RunOptions = {}
): Promise<RunResult<Out>> {
  const config = options.config ?? (await getModelConfig())
  if (!isModelConfigured(config)) {
    return {
      ok: false,
      kind: 'not-configured',
      message: '还没有配置模型接口（设置 → 模型设置），这一步先跳过',
      retriable: false
    }
  }

  const sleep = options.sleep ?? defaultSleep
  const retryDelayMs = options.retryDelayMs ?? 1000
  const maxOutputTokens = outputLimitOf(task, input)
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: task.systemPrompt },
    {
      role: 'user',
      content: options.extraUserParts?.length
        ? [{ type: 'text', text: JSON.stringify(task.buildPayload(input)) }, ...options.extraUserParts]
        : JSON.stringify(task.buildPayload(input))
    }
  ]

  let jsonResponse = config.supportsJsonResponse !== false
  let downgraded = false
  let retriesLeft = 1
  let validationError: string | undefined

  for (;;) {
    const messages: ChatMessage[] = validationError
      ? [...baseMessages, { role: 'user', content: JSON.stringify({ retry: true, validationError }) }]
      : baseMessages

    let result
    try {
      result = await chatCompletion(
        {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages,
          maxOutputTokens,
          jsonResponse,
          timeoutMs: config.timeoutMs
        },
        options.deps
      )
      await logCall(task, config, options, {
        promptTokensEst: result.promptTokensEst,
        completionTokensEst: result.completionTokensEst,
        durationMs: result.durationMs,
        status: 'ok'
      })
    } catch (cause) {
      const error = toLlmError(cause)
      await logCall(task, config, options, {
        promptTokensEst: 0,
        completionTokensEst: 0,
        durationMs: 0,
        status: 'error',
        errorKind: error.kind
      })
      // response_format 不被支持：记进配置备忘录并去掉该参数重试一次，这次不算重试额度
      if (error.kind === 'unsupported-param' && jsonResponse && !downgraded) {
        jsonResponse = false
        downgraded = true
        await saveModelConfig({ supportsJsonResponse: false })
        continue
      }
      // 有的服务（DeepSeek 就是）在 JSON 模式下会「返回 200 但正文为空」：
      // 同样按「这个接口的 JSON 模式不好用」处理，去掉 response_format 再试一次，
      // 否则用户会卡在一个看不出原因的失败上（§6.8 的降级路径）。
      if (error.kind === 'empty-response' && jsonResponse && !downgraded) {
        jsonResponse = false
        downgraded = true
        await saveModelConfig({ supportsJsonResponse: false })
        continue
      }
      if (error.retriable && retriesLeft > 0) {
        retriesLeft -= 1
        await sleep(retryDelayMs * 2 ** (1 - retriesLeft))
        continue
      }
      return { ok: false, kind: error.kind, message: error.message, retriable: error.retriable, raw: error.detail }
    }

    let parsed: unknown
    try {
      parsed = parseJsonFromModel(result.text)
    } catch (cause) {
      const error = toLlmError(cause)
      if (retriesLeft > 0) {
        retriesLeft -= 1
        validationError = error.message
        continue
      }
      return { ok: false, kind: error.kind, message: error.message, retriable: false, raw: result.text.slice(0, 500) }
    }

    const checked = task.schema.safeParse(parsed)
    if (!checked.success) {
      const issues = formatIssues(checked.error)
      if (retriesLeft > 0) {
        retriesLeft -= 1
        validationError = issues
        continue
      }
      return {
        ok: false,
        kind: 'schema',
        message: `模型返回的结构不符合约定：${issues.split('; ')[0]}`,
        retriable: false,
        raw: result.text.slice(0, 500),
        validationError: issues
      }
    }

    return { ok: true, value: checked.data, model: result.model, durationMs: result.durationMs }
  }
}

export interface ProbeResult {
  ok: boolean
  message: string
  model?: string
  durationMs?: number
  /** 探测后接口是否支持 response_format=json_object */
  supportsJsonResponse?: boolean
}

/**
 * 连通性探测（FR-1301）。顺手把「支不支持 response_format」探测结果写进配置备忘录，
 * 后续请求就不用再撞一次 400。
 */
export async function probeModel(config: ModelConfigRecord, deps: ClientDeps = {}): Promise<ProbeResult> {
  if (!isModelConfigured(config)) {
    const message = '地址 / token / 模型名要填齐才能测试'
    await saveModelConfig({ lastTestAt: Date.now(), lastTestOk: false, lastTestMessage: message })
    return { ok: false, message }
  }

  const messages: ChatMessage[] = [
    // 提示词里必须**原样出现小写 json**：DeepSeek 的 JSON 模式有这个硬要求，
    // 否则它会返回空内容 —— 探活本身因此失败，用户看到的是「接口返回了空内容」（2026-10-15 踩过）。
    { role: 'system', content: '你是连通性测试助手，只回复一段 json，不要解释。' },
    { role: 'user', content: '请回复这样的 json：{"ping":true}' }
  ]
  let supportsJsonResponse = config.supportsJsonResponse !== false
  let note = ''

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await chatCompletion(
        {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages,
          // 32 对推理型模型太小：预算全花在思考上、正文就是空的。探活给宽一点。
          maxOutputTokens: 128,
          jsonResponse: supportsJsonResponse,
          timeoutMs: Math.min(config.timeoutMs, 20_000)
        },
        deps
      )
      const message = `连接正常（${Math.round(result.durationMs)}ms，约 ${result.completionTokensEst} tokens 输出）${note}`
      await saveModelConfig({
        supportsJsonResponse,
        lastTestAt: Date.now(),
        lastTestOk: true,
        lastTestMessage: message
      })
      return { ok: true, message, model: result.model, durationMs: result.durationMs, supportsJsonResponse }
    } catch (cause) {
      const error = toLlmError(cause)
      if (error.kind === 'unsupported-param' && supportsJsonResponse) {
        supportsJsonResponse = false
        note = '；接口不支持 response_format，已自动降级'
        continue
      }
      await saveModelConfig({ lastTestAt: Date.now(), lastTestOk: false, lastTestMessage: error.message })
      return { ok: false, message: error.message, supportsJsonResponse }
    }
  }

  const message = '探测失败'
  await saveModelConfig({ lastTestAt: Date.now(), lastTestOk: false, lastTestMessage: message })
  return { ok: false, message }
}

export { chatCompletion, chatCompletionsUrl, normalizeBaseUrl } from './client'
export { LlmError, toLlmError, type LlmErrorKind } from './errors'
export { parseJsonFromModel, estimateTokens, stripCodeFence, findJsonSpan } from './text'
export type { LlmTask } from './types'
export type { ChatMessage, ChatResult, ClientDeps } from './client'
export { IMAGE_TOKEN_ESTIMATE } from './client'
