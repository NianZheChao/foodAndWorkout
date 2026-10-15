/**
 * 待办队列执行器（T2.4 / §6.10 / FR-1504）。
 *
 * 记录链路永远不被模型阻塞：未配模型或断网时先落占位条目并把活儿写进 `pendingOps`。
 * 这个执行器负责在**联网且已配置模型**时把队列串行重放：
 * - `food.resolve`：把查询解析成食物 → 落库 → 用条目自己的克数回算 → 清掉「待补全」标记。
 * - `log.parse`：用草稿里的原文重新解析（图片按设计不落库，只有图片的草稿只能请用户重拍）。
 *
 * 三条自我约束：
 * 1. **只在结果干净时自动写**：可疑值（越界 / 宏量不自洽）与低置信度一律转成「需要处理」，
 *    等用户在界面上确认（FR-407）——自动回填不等于替用户拍板。
 * 2. **不重复入队**：重放时关掉失败入队，否则每次重试都会再排一条，队列越滚越长。
 * 3. **不对用户静默**：修好了给一条消息，修不动说清原因。
 */

import { getDraft } from '@/data/repositories/drafts'
import { listPendingIntake, updateIntake } from '@/data/repositories/intake'
import { getModelConfig, isModelConfigured } from '@/data/repositories/modelConfig'
import { listOpenOps, markOp } from '@/data/repositories/pendingOps'
import { normalizeFoodName } from '@/domain/foodName'
import { factsForGrams } from '@/domain/nutrition'
import type { IntakeEntry, PendingOp } from '@/domain/types'
import type { RunOptions } from '@/llm'
import { persistCandidate, resolveFoods } from './foodResolve'
import { parseLog } from './logParse'

/** 一次最多处理多少条；剩下的等下一次（启动 / 联网）再跑，避免长时间占着网络。 */
export const QUEUE_BATCH_LIMIT = 20
/** 连续等待失败到这个次数就转「需要处理」，不再无限重试。 */
export const MAX_QUEUE_ATTEMPTS = 3

export interface QueueReport {
  /** 是否真的跑了（未配模型 / 离线时为 false，不产生任何写入） */
  ran: boolean
  /** 没跑的原因 */
  skipped: string[]
  done: number
  waiting: number
  needsAttention: number
  /** 给用户看的结论，调用方决定怎么展示 */
  messages: string[]
}

export interface RunQueueOptions {
  limit?: number
  /** 显式传模型配置 / fetch 替身（测试用） */
  run?: RunOptions
  /** 显式声明在线状态；缺省读 `navigator.onLine` */
  online?: boolean
}

function isOnline(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true
  return navigator.onLine
}

/** 同一条查询可能被排了多次队（用户重复提交），按 (kind, ref) 归并成一次请求。 */
function groupOps(ops: readonly PendingOp[]): PendingOp[][] {
  const groups = new Map<string, PendingOp[]>()
  for (const op of ops) {
    const key = `${op.kind}::${op.ref}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(op)
    else groups.set(key, [op])
  }
  return [...groups.values()]
}

async function settle(ops: readonly PendingOp[], status: PendingOp['status'], lastError?: string): Promise<void> {
  for (const op of ops) {
    await markOp(op.id, { status, lastError })
  }
}

/** 失败一次：还能重试就回 waiting，否则交给用户。 */
async function recordFailure(op: PendingOp, message: string, retriable: boolean): Promise<'waiting' | 'needs-attention'> {
  const attempts = op.attempts + 1
  const status: PendingOp['status'] = retriable && attempts < MAX_QUEUE_ATTEMPTS ? 'waiting' : 'needs-attention'
  await markOp(op.id, { status, attempts, lastError: message })
  return status
}

interface ReplayResult {
  status: PendingOp['status']
  message?: string
  /** 这次回填了几条记录（只有 `food.resolve` 会用到） */
  applied?: number
}

/** 重放一条 `food.resolve`，并用同名的待补全条目回算。 */
async function replayFoodResolve(
  op: PendingOp,
  pending: readonly IntakeEntry[],
  run: RunOptions
): Promise<ReplayResult> {
  const target = normalizeFoodName(op.ref)
  const entries = pending.filter(
    (entry) => entry.pendingFlag === 1 && normalizeFoodName(entry.foodSnapshot.name) === target
  )
  if (!entries.length) return { status: 'done', message: '已经没有待补全的条目，队列项关闭' }

  const outcome = await resolveFoods([op.ref], run, { enqueueOnFailure: false })
  if (outcome.failure) {
    const status = await recordFailure(op, outcome.failure.message, outcome.failure.retriable)
    return { status, message: status === 'waiting' ? undefined : `「${op.ref}」补全失败：${outcome.failure.message}` }
  }

  const candidate = outcome.candidates[0]
  if (!candidate?.matched || !candidate.food) {
    const message = candidate?.message ?? '模型没能确认这个食物，请手工录入营养值'
    await markOp(op.id, { status: 'needs-attention', lastError: message })
    return { status: 'needs-attention', message: `「${op.ref}」${message}` }
  }
  if (candidate.needsConfirm) {
    const reason = candidate.suspicious.join('；') || '模型给的值置信度低'
    await markOp(op.id, { status: 'needs-attention', lastError: reason })
    return { status: 'needs-attention', message: `「${op.ref}」需要你确认后才能回填：${reason}` }
  }

  const food = await persistCandidate(candidate.food)
  const blocked: string[] = []
  let applied = 0
  for (const entry of entries) {
    const grams = entry.amount.grams
    if (grams === undefined) {
      blocked.push(entry.date)
      continue
    }
    await updateIntake(entry.id, {
      foodId: food.id,
      foodSnapshot: {
        name: food.name,
        unit: food.unit,
        basisGrams: food.basisGrams,
        kcal: food.kcal,
        proteinG: food.proteinG,
        fatG: food.fatG,
        carbG: food.carbG,
        fiberG: food.fiberG,
        sodiumMg: food.sodiumMg
      },
      computed: factsForGrams(food, grams),
      pendingFlag: 0
    })
    applied += 1
  }

  if (blocked.length) {
    const message = `${blocked.length} 条记录只有份量写法、没有克数，补上克数后才能回算`
    await markOp(op.id, { status: 'needs-attention', lastError: message })
    return { status: 'needs-attention', message: `「${op.ref}」${message}`, applied }
  }

  await markOp(op.id, { status: 'done', lastError: undefined })
  return { status: 'done', applied, message: `已自动补全「${food.name}」${applied} 条记录` }
}

/** 重放一条 `log.parse`：用草稿里的原文重新解析。 */
async function replayLogParse(op: PendingOp, run: RunOptions): Promise<ReplayResult> {
  const draft = await getDraft(op.ref)
  if (!draft) return { status: 'done', message: '草稿已经不在了，队列项关闭' }
  if (!draft.rawText.trim()) {
    const message = '这条草稿只有图片，图片不落库，请重新拍一张或改用文字描述'
    await markOp(op.id, { status: 'needs-attention', lastError: message })
    return { status: 'needs-attention', message }
  }

  const outcome = await parseLog(
    {
      date: draft.date,
      text: draft.rawText,
      kind: draft.kind,
      meal: draft.meal,
      draftId: draft.id
    },
    run,
    { enqueueOnFailure: false }
  )
  if (outcome.status === 'failed') {
    const status = await recordFailure(op, outcome.failure.message, outcome.failure.retriable)
    return {
      status,
      message: status === 'waiting' ? undefined : `草稿重新解析失败：${outcome.failure.message}`
    }
  }
  await markOp(op.id, { status: 'done', lastError: undefined })
  return { status: 'done', applied: 0, message: '有草稿已经重新解析完成，去「一句话记录」确认' }
}

/**
 * 串行重放待办队列。任何一步失败都不抛异常，只把该条标成 waiting / needs-attention。
 */
export async function runQueue(options: RunQueueOptions = {}): Promise<QueueReport> {
  const report: QueueReport = { ran: false, skipped: [], done: 0, waiting: 0, needsAttention: 0, messages: [] }

  const config = options.run?.config ?? (await getModelConfig())
  if (!isModelConfigured(config)) {
    report.skipped.push('还没有配置模型接口，队列先等着')
    return report
  }
  if (!(options.online ?? isOnline())) {
    report.skipped.push('当前离线，等联网后再补')
    return report
  }

  const ops = await listOpenOps()
  if (!ops.length) return report
  report.ran = true

  const run: RunOptions = { ...options.run, config }
  const pending = await listPendingIntake()
  const groups = groupOps(ops).slice(0, options.limit ?? QUEUE_BATCH_LIMIT)

  for (const group of groups) {
    const [first] = group
    let result: ReplayResult
    if (first.kind === 'food.resolve') {
      result = await replayFoodResolve(first, pending, run)
    } else if (first.kind === 'log.parse') {
      result = await replayLogParse(first, run)
    } else {
      // report.generate 属阶段 3；现在只把它交给用户，不要假装处理过
      await settle(group, 'needs-attention', '这次重放还不支持这个任务类型')
      result = { status: 'needs-attention', applied: 0 }
    }

    // 同一条查询的重复队列项一起收口，避免下次重放又来一遍
    const stragglers = group.filter((op) => op.id !== first.id)
    if (stragglers.length) {
      await settle(stragglers, result.status, result.status === 'done' ? undefined : result.message)
    }

    if (result.status === 'done') report.done += 1
    else if (result.status === 'waiting') report.waiting += 1
    else report.needsAttention += 1
    if (result.message) report.messages.push(result.message)
  }

  return report
}
