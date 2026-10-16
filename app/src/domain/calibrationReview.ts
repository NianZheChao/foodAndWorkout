/**
 * 校准复核（T3.5 / §6.7）：**本地数字 + 模型判断 + 三道本地门禁**。
 *
 * 分工与报告、每日指导一致：实测 TDEE、均线、达标率全部本地算（`domain/tdee.ts` / `domain/trend.ts`），
 * 模型只负责「要不要动、动多少、为什么」，动完由用户显式采纳；门禁（样本 / 频率 / 幅度）
 * 一律在本地，模型说什么都不放行超限的幅度。
 *
 * 为什么幅度门禁在**本地**再判一次：`proposeCalibration` 的限幅只保护本地建议，
 * 模型完全可以回一个 −400 kcal。FR-904 是安全边界，不能靠提示词自觉。
 */

import { MAX_CALIBRATION_KCAL, proposeCalibration, type CalibrationProposal } from '@/domain/calibration'
import { MIN_COVERAGE_RATIO } from '@/domain/reportDigest'
import { flagUnknownNumbersInTexts } from '@/domain/reportGuard'
import { MIN_TDEE_POINTS } from '@/domain/tdee'

/** 距上次校准不足这个天数时就「不建议现在调整」（FR-905）。 */
export const CALIBRATION_MIN_DAYS = 14

export interface CalibrationReviewInput {
  date: string
  window: { label: string; start: string; end: string; days: number }
  weight: { ma7?: number; changeKg?: number; changePctPerWeek?: number; sampleDays: number }
  intake: {
    avgKcal: number
    target: number
    recordedDays: number
    /** 有饮食记录的天数 / 区间天数（与报告同一口径） */
    ratio: number
    kcalHitDays: number
    proteinHitDays: number
  }
  /** 样本不到 `MIN_TDEE_POINTS` 时整块不出现（不给假事实，同报告 §6.4） */
  tdee?: { value: number; sampleDays: number; confidence: '初步估算' | '可用' }
  currentTargets: { kcalTarget: number; proteinTargetG: number; targetRateKgPerWeek: number }
  /** 上一次校准（供模型判断频率，也供门禁判断） */
  lastCalibration?: { date: string; deltaKcal: number; daysSince: number }
  /** 本地按同一套口径算出来的建议；模型可以同意、反对，但幅度不许超限 */
  localProposal: { kcalTarget: number; deltaKcal: number; clamped: boolean }
}

export interface CalibrationReviewContent {
  recommended: boolean
  deltaKcal: number
  direction: '上调' | '下调' | '不变'
  confidence: 'low' | 'medium' | 'high'
  rationale: string
  watchItems: string[]
}

export interface CalibrationGateOutcome {
  content: CalibrationReviewContent
  notices: string[]
  /** true = 这次不建议现在调整：界面不提供「采纳」，只说明原因 */
  blocked: boolean
}

/**
 * 三道门禁 + 两条自洽修正。任何一条拦下都只影响「能不能采纳」，本地数字照常展示。
 *
 * 拦下时把 `deltaKcal` 归零、`direction` 置「不变」：与报告里 `applyCalibrationGate` 的处理一致 ——
 * 建议一旦作废，数字就不该留在结构化字段里等着被谁读走（原数字写进提示文本，不藏着）。
 */
export function applyCalibrationReviewGates(
  content: CalibrationReviewContent,
  input: CalibrationReviewInput
): CalibrationGateOutcome {
  const notices: string[] = []
  let blocked = false
  let next: CalibrationReviewContent = { ...content }

  const block = (reason: string): void => {
    blocked = true
    notices.push(reason)
    next = { ...next, recommended: false, deltaKcal: 0, direction: '不变' }
  }

  // ① 样本门禁（与报告同一门槛：TDEE 反推 ≥7 天、覆盖率 ≥50%）
  if (!input.tdee || input.tdee.sampleDays < MIN_TDEE_POINTS) {
    block(
      `实测 TDEE 的样本不够（需要 ≥${MIN_TDEE_POINTS} 天同时有体重与饮食记录），这次不给校准建议（FR-707）。`
    )
  } else if (input.intake.ratio < MIN_COVERAGE_RATIO) {
    block(
      `近 ${input.window.days} 天只有 ${input.intake.recordedDays} 天有饮食记录（不到一半），样本不足，` +
        '这次不给校准建议（FR-708）。'
    )
  }

  // ② 频率门禁（FR-905）：不足两周就"建议再观察"，而不是直接允许改
  const daysSince = input.lastCalibration?.daysSince
  if (daysSince !== undefined && daysSince < CALIBRATION_MIN_DAYS) {
    block(
      `距上次校准只有 ${daysSince} 天（< ${CALIBRATION_MIN_DAYS} 天），体重的变化还分不清是水还是脂肪，` +
        '建议再观察（FR-905）。'
    )
  }

  // ③ 幅度门禁（FR-904）：单次最多 ±150 kcal
  if (Math.abs(next.deltaKcal) > MAX_CALIBRATION_KCAL) {
    block(
      `模型建议调整 ${next.deltaKcal} kcal，超过单次 ±${MAX_CALIBRATION_KCAL} kcal 的上限（FR-904），` +
        '已按「不建议现在调整」处理；要改请分次校准，或在目标页显式确认。'
    )
  }

  // ④ 自洽：说「建议调整」却给 0 幅度 —— 当成「不建议调整」，别让它变成一个空的行动项
  if (next.recommended && next.deltaKcal === 0) {
    notices.push('模型给了「建议调整」但幅度是 0，已按「不建议现在调整」处理。')
    next = { ...next, recommended: false, direction: '不变' }
  }

  // ⑤ 自洽：方向必须与幅度符号一致，不一致以幅度为准（数字是硬事实，词不是）
  if (next.recommended && next.deltaKcal !== 0) {
    const expected: CalibrationReviewContent['direction'] = next.deltaKcal > 0 ? '上调' : '下调'
    if (next.direction !== expected) {
      notices.push(`方向的写法与幅度不一致（写的是「${next.direction}」，幅度是 ${next.deltaKcal} kcal），已按幅度修正。`)
      next = { ...next, direction: expected }
    }
  }

  return { content: next, notices, blocked }
}

/** 复核里所有会展示给用户的文字（数字守卫的扫描面）。 */
export function calibrationReviewTexts(content: CalibrationReviewContent): string[] {
  return [content.rationale, ...content.watchItems]
}

/** 数字守卫：白名单来自输入（模型只能引用本地给它的数）。 */
export function flagCalibrationNumbers(
  content: CalibrationReviewContent,
  input: CalibrationReviewInput
): string[] {
  return flagUnknownNumbersInTexts(calibrationReviewTexts(content), input)
}

/** 本地建议：与目标页「按实测 TDEE 生成建议」完全同一套口径（含 ±150 kcal 限幅）。 */
export function localProposalOf(input: CalibrationReviewInput): CalibrationProposal | undefined {
  if (!input.tdee) return undefined
  return proposeCalibration(
    input.tdee.value,
    input.currentTargets.kcalTarget,
    input.currentTargets.targetRateKgPerWeek
  )
}
