/**
 * 每日指导用例层（T3.7 / §6.4.2，A 级 P0）。
 *
 * 与报告同一套分工：**数字与缺口全部本地算**（近 7 天摘要 + 当日缺口），
 * **诊断文字来自模型**，中间过三道本地闸门 —— 依据校验（NFR-13）、样本门禁、数字守卫。
 *
 * 三条纪律：
 * 1. **同日默认只生成一次**：数据没变就复用今天那一版，不重复花钱（指纹见 `domain/coach.ts`）；
 * 2. **模型失败不写任何指导**，但本地缺口提示照常给（无模型降级，§9.3）；
 * 3. **表态是数据**：采纳 / 不采纳写进 `adviceLog`，成为下一轮 `history.advice` 的输入。
 */

import { addDays, recentDates } from '@/app/date'
import { getAdvice, getAdviceByDate, listRecentAdvice, putAdvice } from '@/data/repositories/adviceLog'
import { listDaysInRange } from '@/data/repositories/days'
import { listIntakeInRange, newId } from '@/data/repositories/intake'
import { getSettings } from '@/data/repositories/settings'
import { listWorkoutInRange } from '@/data/repositories/workout'
import {
  applyBasisGate,
  applyCoachCoverageGate,
  buildCoachHistory,
  coachFingerprint,
  flagCoachNumbers,
  type CoachSource
} from '@/domain/coach'
import { sumFacts } from '@/domain/nutrition'
import { buildReportDigest } from '@/domain/reportDigest'
import { buildHints } from '@/domain/targets'
import { runTask, type RunFailure, type RunOptions } from '@/llm'
import { coachDailyTask, type CoachTaskInput } from '@/llm/tasks/coach'
import { loadDigestTargets } from './report'
import type { AdviceRecord, CoachTodayGap, SettingsRecord } from '@/domain/types'

/** 指导看的窗口：近 7 天滚动（§6.4.2）。 */
export const COACH_WINDOW_DAYS = 7
/** 每次多读几条历史记录，再由 `buildCoachHistory` 压到 5 条表态（NFR-14 注意力预算）。 */
const HISTORY_RECORDS_READ = 14

/** FR-1602：睡眠 / 精力 / 酸痛可以单独关掉，缺省全开。 */
export interface ShareRecovery {
  sleep: boolean
  energy: boolean
  soreness: boolean
}

export const DEFAULT_SHARE_RECOVERY: ShareRecovery = { sleep: true, energy: true, soreness: true }

/** 老数据里没有 `shareRecovery`：**缺省全开**（不能因为加了个开关就把老用户的数据默认藏起来）。 */
export function resolveShareRecovery(settings?: SettingsRecord): ShareRecovery {
  return {
    sleep: settings?.shareRecovery?.sleep !== false,
    energy: settings?.shareRecovery?.energy !== false,
    soreness: settings?.shareRecovery?.soreness !== false
  }
}

export interface CoachContext {
  date: string
  windowStart: string
  /** 即将（或已经）发出去的全部输入 —— 界面用它做「将要发送的内容」预览（FR-1602） */
  input: CoachTaskInput
  source: CoachSource
  fingerprint: string
  /** 无模型 / 模型失败时的本地兜底：今天的缺口提示（与今日页「今天要注意」同源） */
  localHints: string[]
}

/**
 * 组装一天的指导输入。
 *
 * 输入里**没有一条原始记录、没有备注原文、没有用户原话**：摘要负责汇总，
 * 当日缺口负责「还差多少」，主动关掉的恢复类字段连聚合都不参与（关掉就不该出现在任何地方）。
 */
export async function buildCoachContext(
  date: string,
  options: { shareRecovery?: ShareRecovery } = {}
): Promise<CoachContext> {
  const share = options.shareRecovery ?? DEFAULT_SHARE_RECOVERY
  const windowStart = addDays(date, -(COACH_WINDOW_DAYS - 1))
  const [targets, dayRows, intakeRows, workoutRows, historyRecords] = await Promise.all([
    loadDigestTargets(),
    listDaysInRange(windowStart, date),
    listIntakeInRange(windowStart, date),
    listWorkoutInRange(windowStart, date),
    listRecentAdvice(HISTORY_RECORDS_READ)
  ])

  const dayByDate = new Map(dayRows.map((row) => [row.date, row]))
  const groupBy = <T extends { date: string }>(rows: readonly T[]): Map<string, T[]> => {
    const grouped = new Map<string, T[]>()
    for (const row of rows) {
      const bucket = grouped.get(row.date)
      if (bucket) bucket.push(row)
      else grouped.set(row.date, [row])
    }
    return grouped
  }
  const intakeByDate = groupBy(intakeRows)
  const workoutByDate = groupBy(workoutRows)

  const dates = recentDates(date, COACH_WINDOW_DAYS)
  const days = dates.map((day) => {
    const dayRow = dayByDate.get(day)
    const entries = intakeByDate.get(day) ?? []
    return {
      date: day,
      weightAmKg: dayRow?.weightAmKg,
      weightPmKg: dayRow?.weightPmKg,
      // 主动关掉的恢复类字段在这里就切断：既不进摘要聚合，也不进请求
      sleepHours: share.sleep ? dayRow?.sleepHours : undefined,
      energy: share.energy ? dayRow?.energy : undefined,
      soreness: share.soreness ? dayRow?.soreness : undefined,
      intake: sumFacts(entries.map((entry) => entry.computed)),
      hasIntakeRows: entries.length > 0,
      workouts: workoutByDate.get(day) ?? []
    }
  })

  const digest = buildReportDigest({
    period: {
      type: 'weekly',
      label: `近 ${COACH_WINDOW_DAYS} 天`,
      start: windowStart,
      end: date,
      days: COACH_WINDOW_DAYS
    },
    days,
    targets
  })

  const todayIntake = intakeByDate.get(date) ?? []
  const facts = sumFacts(todayIntake.map((entry) => entry.computed))
  const today: CoachTodayGap = {
    kcalSoFar: Math.round(facts.kcal),
    proteinSoFarG: Math.round(facts.proteinG),
    // 没设目标就没有「还差多少」：留空而不是补 0（补 0 会被模型当成事实引用）
    remainingKcal: targets.kcalTarget > 0 ? Math.round(targets.kcalTarget - facts.kcal) : undefined,
    remainingProteinG: targets.proteinTargetG > 0 ? Math.round(targets.proteinTargetG - facts.proteinG) : undefined,
    pendingItems: todayIntake.filter((entry) => entry.pendingFlag === 1).length,
    // 拉伸不算「今天练了」（与训练容量口径一致：容量只算力量动作）
    trainedToday: (workoutByDate.get(date) ?? []).some((row) => row.type !== '拉伸'),
    weightAmKg: dayByDate.get(date)?.weightAmKg
  }

  // 历史只带**今天之前**的表态：今天自己那条的表态不该让今天的指纹失效（否则点一下「采纳」就提示「数据有更新」）
  const history = { advice: buildCoachHistory(historyRecords.filter((row) => row.date < date)) }
  const source: CoachSource = { digest, today }

  return {
    date,
    windowStart,
    input: { date, digest, today, history },
    source,
    fingerprint: coachFingerprint(source),
    localHints: buildHints(facts, targets)
  }
}

export interface GenerateAdviceOutcome {
  ok: boolean
  record?: AdviceRecord
  /** true = 命中当日缓存，这次没有调用模型 */
  cached?: boolean
  failure?: Pick<RunFailure, 'kind' | 'message' | 'retriable'>
  notices: string[]
}

export interface GenerateAdviceInput {
  date: string
  /** true = 用户手动刷新：数据没变也再问一次模型 */
  force?: boolean
}

/**
 * 生成（或复用）某一天的指导。
 *
 * 模型失败时**不落库**（也不覆盖已有的那一版）：指导不是数值区，没有本地保底内容可存，
 * 界面改用 `localHints` 兜底（§9.3 的降级矩阵）。
 */
export async function generateAdvice(
  input: GenerateAdviceInput,
  options: RunOptions = {}
): Promise<GenerateAdviceOutcome> {
  const settings = await getSettings()
  const context = await buildCoachContext(input.date, { shareRecovery: resolveShareRecovery(settings) })
  const existing = await getAdviceByDate(input.date)

  // 同日默认只生成一次：数据没变又没有手动刷新，就直接用今天那一版（§6.4.2 频率与缓存）
  if (existing && existing.fingerprint === context.fingerprint && !input.force) {
    return { ok: true, record: existing, cached: true, notices: existing.notices ?? [] }
  }

  const result = await runTask(coachDailyTask, context.input, options)
  if (!result.ok) {
    return {
      ok: false,
      failure: { kind: result.kind, message: result.message, retriable: result.retriable },
      notices: []
    }
  }

  const basisGate = applyBasisGate(result.value, context.source)
  const coverageGate = applyCoachCoverageGate(basisGate.content, context.source.digest)
  const content = coverageGate.content
  const droppedAdvice = [...basisGate.dropped, ...coverageGate.dropped].length
  const notices = [...basisGate.notices, ...coverageGate.notices]
  const now = Date.now()
  const record: AdviceRecord = {
    // 同一天重新生成**覆盖**当天那一条（与报告的「保留历史版本」不同：指导过期就没有参考价值，
    // 留着只会让「今天看哪一条」变得含糊）
    id: existing?.id ?? newId('adv'),
    date: input.date,
    content,
    fingerprint: context.fingerprint,
    model: result.model,
    taskVersion: coachDailyTask.version,
    flaggedNumbers: flagCoachNumbers(content, context.source),
    droppedAdvice: droppedAdvice || undefined,
    notices: notices.length ? notices : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  await putAdvice(record)
  return { ok: true, record, notices }
}

/** 「采纳 / 不采纳」表态：只改那一条，供下一轮 `history.advice` 使用（§6.4.2 落库）。 */
export async function markAdviceAdopted(
  id: string,
  index: number,
  adopted: boolean
): Promise<AdviceRecord | undefined> {
  const current = await getAdvice(id)
  if (!current) return undefined
  const advice = current.content.advice.map((item, itemIndex) =>
    itemIndex === index ? { ...item, adopted } : item
  )
  const next: AdviceRecord = {
    ...current,
    content: { ...current.content, advice },
    updatedAt: Date.now()
  }
  await putAdvice(next)
  return next
}
