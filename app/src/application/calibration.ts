/**
 * 校准向导用例层（T3.5 / §6.7）。
 *
 * 分工与报告、每日指导一致：**数字全部本地算**（近 4 周摘要：实测 TDEE、均线、达标率、覆盖率），
 * 模型只回「要不要动、动多少、为什么」，动完由用户显式采纳。
 *
 * 三条纪律：
 * 1. **一次性的向导，不落库**：AI 复核结果只在页面内存里存在；采纳时走 `applyCalibration`
 *    （写目标 + 留一行校准记录），没采纳就什么都不写 —— 没有一个"待复核"状态需要用户回来收尾；
 * 2. **本地建议永远可用**：没配模型 / 模型失败时用 `proposeCalibration` 的本地建议兜底（§9.3）；
 * 3. **门禁在本地**：样本、频率、幅度全部由 `domain/calibrationReview.ts` 再判一次，
 *    模型回一个 −400 kcal 也进不了「采纳」（FR-904 是安全边界，不能靠提示词自觉）。
 */

import { addDays, daysBetween, recentDates } from '@/app/date'
import { listCalibrations, getTargets } from '@/data/repositories/targets'
import { listDaysInRange } from '@/data/repositories/days'
import { listIntakeInRange } from '@/data/repositories/intake'
import { listWorkoutInRange } from '@/data/repositories/workout'
import {
  applyCalibrationReviewGates,
  flagCalibrationNumbers,
  localProposalOf,
  type CalibrationReviewContent,
  type CalibrationReviewInput
} from '@/domain/calibrationReview'
import { proposeCalibration, type CalibrationProposal } from '@/domain/calibration'
import { sumFacts } from '@/domain/nutrition'
import { buildReportDigest } from '@/domain/reportDigest'
import { runTask, type RunFailure, type RunOptions } from '@/llm'
import { calibrationReviewTask } from '@/llm/tasks/calibration'
import { loadDigestTargets } from './report'

/** 校准看的窗口：近 4 周（28 个自然日，含今天）。 */
export const CALIBRATION_WINDOW_DAYS = 28

/**
 * 组装校准复核的输入。
 *
 * 区间按自然日铺满（没记录的天也占位），所以覆盖率的分母是 **28**（与报告同一口径），
 * 而不是"有记录的天数" —— 否则只记 3 天也会被算成 100%，样本门禁形同虚设（FR-708）。
 */
export async function buildCalibrationReviewInput(date: string): Promise<CalibrationReviewInput> {
  const start = addDays(date, -(CALIBRATION_WINDOW_DAYS - 1))
  const [targets, targetsRow, dayRows, intakeRows, workoutRows, calibrations] = await Promise.all([
    loadDigestTargets(),
    getTargets(),
    listDaysInRange(start, date),
    listIntakeInRange(start, date),
    listWorkoutInRange(start, date),
    listCalibrations()
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

  const days = recentDates(date, CALIBRATION_WINDOW_DAYS).map((day) => {
    const dayRow = dayByDate.get(day)
    const entries = intakeByDate.get(day) ?? []
    return {
      date: day,
      weightAmKg: dayRow?.weightAmKg,
      weightPmKg: dayRow?.weightPmKg,
      sleepHours: dayRow?.sleepHours,
      energy: dayRow?.energy,
      soreness: dayRow?.soreness,
      intake: sumFacts(entries.map((entry) => entry.computed)),
      hasIntakeRows: entries.length > 0,
      workouts: workoutByDate.get(day) ?? []
    }
  })

  const digest = buildReportDigest({
    period: {
      // 复用报告的"月报"周期壳：这里只看 28 天滚动窗口，`type` 仅作标记
      type: 'monthly',
      label: `近 ${CALIBRATION_WINDOW_DAYS} 天`,
      start,
      end: date,
      days: CALIBRATION_WINDOW_DAYS
    },
    days,
    targets
  })

  // 上次校准：优先用校准记录里的真实幅度；只有 `lastCalibrated` 标记时给 0（幅度未知，
  // 频率门禁只用到 daysSince，界面上会说明"记录缺失"）
  const latest = calibrations[0]
  const lastCalibration = latest
    ? {
        date: latest.date,
        deltaKcal: Math.round(latest.kcalAfter - latest.kcalBefore),
        daysSince: daysBetween(latest.date, date)
      }
    : targetsRow?.lastCalibrated
      ? { date: targetsRow.lastCalibrated, deltaKcal: 0, daysSince: daysBetween(targetsRow.lastCalibrated, date) }
      : undefined

  const currentTargets = {
    kcalTarget: digest.currentTargets.kcalTarget,
    proteinTargetG: digest.currentTargets.proteinTargetG,
    targetRateKgPerWeek: targetsRow?.targetRateKgPerWeek ?? 0
  }

  const input: CalibrationReviewInput = {
    date,
    window: { label: digest.period.label, start, end: date, days: CALIBRATION_WINDOW_DAYS },
    weight: {
      ma7: digest.weight.ma7,
      changeKg: digest.weight.changeKg,
      changePctPerWeek: digest.weight.changePctPerWeek,
      sampleDays: digest.coverage.daysWithWeight
    },
    intake: {
      avgKcal: digest.intake.avgKcal,
      target: digest.intake.target,
      recordedDays: digest.intake.recordedDays,
      ratio: digest.coverage.ratio,
      kcalHitDays: digest.intake.kcalHitDays,
      proteinHitDays: digest.intake.proteinHitDays
    },
    tdee: digest.tdee,
    currentTargets,
    lastCalibration,
    localProposal: localProposalPayload(digest.tdee?.value, currentTargets)
  }
  return input
}

/**
 * 本地建议在 payload 里的形态（模型可以同意、反对，幅度不许超限）。
 * 没有 TDEE 就没有可算的建议：给「维持现状」，而不是编一个幅度出来。
 */
function localProposalPayload(
  measuredTdee: number | undefined,
  currentTargets: CalibrationReviewInput['currentTargets']
): CalibrationReviewInput['localProposal'] {
  if (measuredTdee === undefined) {
    return { kcalTarget: currentTargets.kcalTarget, deltaKcal: 0, clamped: false }
  }
  const proposal = proposeCalibration(measuredTdee, currentTargets.kcalTarget, currentTargets.targetRateKgPerWeek)
  return { kcalTarget: proposal.kcalTarget, deltaKcal: proposal.deltaKcal, clamped: proposal.clamped }
}

export interface CalibrationReviewOutcome {
  ok: boolean
  content?: CalibrationReviewContent
  /** 本地闸门给出的提示（样本不足、频率太近、幅度超限等） */
  notices: string[]
  /** true = 这次不建议现在调整：界面不提供「采纳」，只说明原因 */
  blocked: boolean
  /** 模型文本里被数字守卫标为「待核对」的数字 */
  flagged: string[]
  /** 本地建议（没配模型 / 模型失败时的兜底） */
  local?: CalibrationProposal
  model?: string
  taskVersion?: number
  failure?: Pick<RunFailure, 'kind' | 'message' | 'retriable'>
}

/**
 * 跑一次 AI 复核。
 *
 * **不落库**：结果只在页面内存里；用户点「采纳」时才写目标与校准记录。
 * 模型失败时给出原因，本地建议照常可用（`local` 字段）。
 */
export async function reviewCalibration(
  input: CalibrationReviewInput,
  options: RunOptions = {}
): Promise<CalibrationReviewOutcome> {
  const local = localProposalOf(input)
  const result = await runTask(calibrationReviewTask, input, options)
  if (!result.ok) {
    return {
      ok: false,
      notices: [],
      blocked: false,
      flagged: [],
      local,
      failure: { kind: result.kind, message: result.message, retriable: result.retriable }
    }
  }

  const gate = applyCalibrationReviewGates(result.value, input)
  return {
    ok: true,
    content: gate.content,
    notices: gate.notices,
    blocked: gate.blocked,
    flagged: flagCalibrationNumbers(gate.content, input),
    local,
    model: result.model,
    taskVersion: calibrationReviewTask.version
  }
}
