/**
 * 报告用例层（T3.1 / T3.2 / T3.3，§6.4）。
 *
 * 分工写死在这里：**数值区永远来自本地聚合**（`buildReportDigest`），
 * **文字区来自模型**（`report.weekly` / `report.monthly`），中间过三道本地闸门：
 * 覆盖率门禁、数字守卫、校准幅度门禁。任何一道拦下来都只影响文字与建议，
 * 数值区照常展示 —— 没配模型时报告也有内容可看（§9.3）。
 *
 * 重新生成**新建一条记录**，旧版本原样留着（FR-710 / T3.3）。
 */

import { getTargets } from '@/data/repositories/targets'
import { listDaysInRange } from '@/data/repositories/days'
import { listIntakeInRange, newId } from '@/data/repositories/intake'
import { listWorkoutInRange } from '@/data/repositories/workout'
import { listReports, putReport } from '@/data/repositories/reports'
import { getReport } from '@/data/repositories/reports'
import { sumFacts } from '@/domain/nutrition'
import { buildReportDigest, coverageWarning, periodOf, type DigestTargets } from '@/domain/reportDigest'
import { applyCalibrationGate, applyCoverageGate, flagUnknownNumbers } from '@/domain/reportGuard'
import { daysBetween, recentDates } from '@/app/date'
import { runTask, type RunFailure, type RunOptions } from '@/llm'
import { reportTaskFor } from '@/llm/tasks/report'
import type { ReportContent, ReportDigest, ReportRecord, ReportType } from '@/domain/types'

/** 报告里的数值区：区间 + 本地摘要（区间可能被「到今天为止」截短）。 */
export type DigestSource = { period: ReturnType<typeof periodOf>; digest: ReportDigest }

/** 摘要需要的目标值；每日指导（`application/coach.ts`）也读这一份，避免两处口径分叉。 */
export async function loadDigestTargets(): Promise<DigestTargets> {
  const targets = await getTargets()
  return {
    kcalTarget: targets?.kcalTarget ?? 0,
    proteinTargetG: targets?.proteinTargetG ?? 0,
    fatTargetG: targets?.fatTargetG ?? 0,
    carbTargetG: targets?.carbTargetG ?? 0,
    fiberTargetG: targets?.fiberTargetG ?? 0,
    sodiumMaxMg: targets?.sodiumMaxMg ?? 0,
    weeklySetsPerMuscle: targets?.weeklySetsPerMuscle,
    weeklyTrainingDays: targets?.weeklyTrainingDays,
    lastCalibrated: targets?.lastCalibrated
  }
}

/**
 * 组装一期的本地摘要。
 *
 * 区间按自然日铺满（没记录的天也占位），这样覆盖率才是「有记录天数 / 区间天数」，
 * 与工作区脚本的「区间」口径一致。
 */
export async function buildDigest(type: ReportType, endDate: string): Promise<DigestSource> {
  const period = periodOf(type, endDate)
  // 未来的日子不能算进报告：本周没走完就只统计到今天
  const start = period.start > endDate ? endDate : period.start
  const end = period.end > endDate ? endDate : period.end
  const [targets, dayRows, intakeRows, workoutRows, previousReports] = await Promise.all([
    loadDigestTargets(),
    listDaysInRange(start, end),
    listIntakeInRange(start, end),
    listWorkoutInRange(start, end),
    listReports(type)
  ])

  const dayByDate = new Map(dayRows.map((row) => [row.date, row]))
  const intakeByDate = new Map<string, typeof intakeRows>()
  for (const row of intakeRows) {
    const bucket = intakeByDate.get(row.date)
    if (bucket) bucket.push(row)
    else intakeByDate.set(row.date, [row])
  }
  const workoutByDate = new Map<string, typeof workoutRows>()
  for (const row of workoutRows) {
    const bucket = workoutByDate.get(row.date)
    if (bucket) bucket.push(row)
    else workoutByDate.set(row.date, [row])
  }

  const dates = recentDates(end, Math.max(1, daysBetween(start, end) + 1))
  const days = dates.map((date) => {
    const dayRow = dayByDate.get(date)
    const entries = intakeByDate.get(date) ?? []
    return {
      date,
      weightAmKg: dayRow?.weightAmKg,
      weightPmKg: dayRow?.weightPmKg,
      // 恢复类字段：报告要用它们支撑「恢复」那一段（趋势页不展示，见 §6.4.1）
      sleepHours: dayRow?.sleepHours,
      energy: dayRow?.energy,
      soreness: dayRow?.soreness,
      intake: sumFacts(entries.map((entry) => entry.computed)),
      hasIntakeRows: entries.length > 0,
      workouts: workoutByDate.get(date) ?? []
    }
  })

  // 上一期的结论文本：取比本期更早、且真的写过结论的那一条
  const previous = previousReports.find((row) => row.periodStart < period.start && row.content)
  const digest = buildReportDigest({
    period: { ...period, start, end, days: dates.length },
    days,
    targets,
    previous: previous
      ? {
          period: previous.label,
          conclusion: previous.content?.summary ?? '',
          // 上一期的数字：只有文字时「比上期」只能靠模型随口说（2026-10-16 补）
          numbers: {
            avgKcal: previous.digest.intake.avgKcal,
            recordedDays: previous.digest.intake.recordedDays,
            kcalHitDays: previous.digest.intake.kcalHitDays,
            proteinHitDays: previous.digest.intake.proteinHitDays,
            trainingDays: previous.digest.training.days,
            volumeLoadKg: previous.digest.training.volumeLoadKg,
            weightChangeKg: previous.digest.weight.changeKg
          }
        }
      : undefined
  })
  return { period: { ...period, start, end, days: dates.length }, digest }
}

export interface GenerateReportOutcome {
  ok: boolean
  report?: ReportRecord
  failure?: Pick<RunFailure, 'kind' | 'message' | 'retriable'>
  /** 被本地闸门拦下或提示的内容（覆盖率、校准幅度） */
  notices: string[]
}

/**
 * 生成一份报告：先算摘要并落库（数值区），再请模型写文字（文字区）。
 *
 * 模型失败**不删除**已生成的数值区记录，只是 `content = null`，状态标 `pending`，
 * 用户可以稍后重新生成（§9.3 的能力矩阵）。
 */
export async function generateReport(
  input: { type: ReportType; endDate: string },
  options: RunOptions = {}
): Promise<GenerateReportOutcome> {
  const notices: string[] = []
  const { period, digest } = await buildDigest(input.type, input.endDate)
  const now = Date.now()
  const base: ReportRecord = {
    id: newId('rep'),
    type: input.type,
    label: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    digest,
    content: null,
    status: 'pending',
    editedByUser: false,
    createdAt: now,
    updatedAt: now
  }

  const warning = coverageWarning(digest)
  if (warning) notices.push(warning)

  const result = await runTask(reportTaskFor(input.type), { type: input.type, digest }, options)
  if (!result.ok) {
    await putReport(base)
    return {
      ok: false,
      report: base,
      failure: { kind: result.kind, message: result.message, retriable: result.retriable },
      notices
    }
  }

  let content = result.value
  const calibrationGate = applyCalibrationGate(content)
  content = calibrationGate.content
  if (calibrationGate.notice) notices.push(calibrationGate.notice)
  const coverageGate = applyCoverageGate(content, digest)
  content = coverageGate.content
  if (coverageGate.notice) notices.push(coverageGate.notice)

  const flaggedNumbers = flagUnknownNumbers(content, digest)
  const record: ReportRecord = {
    ...base,
    content,
    status: 'ready',
    model: result.model,
    taskVersion: reportTaskFor(input.type).version,
    flaggedNumbers,
    updatedAt: Date.now()
  }
  await putReport(record)
  return { ok: true, report: record, notices }
}

/** 人工编辑文字区：留痕（`editedByUser`）但不改数值区（FR-710）。 */
export async function saveEditedContent(
  id: string,
  content: ReportContent
): Promise<ReportRecord | undefined> {
  const current = await getReport(id)
  if (!current) return undefined
  // 界面传进来的对象可能是 Vue 的响应式代理，直接写库会 DataCloneError。
  // 报告内容按契约是纯 JSON，这里深拷一份再落库。
  const plain = JSON.parse(JSON.stringify(content)) as ReportContent
  const next: ReportRecord = {
    ...current,
    content: plain,
    editedByUser: true,
    updatedAt: Date.now()
  }
  await putReport(next)
  return next
}

