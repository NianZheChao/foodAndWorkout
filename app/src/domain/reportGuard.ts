/**
 * 报告的「数字守卫」（T3.2 / §6.4 / DR-37）。
 *
 * 模型写结论时最容易出的事，是把一个**它自己算出来的数**写进正文（「这周平均每天多吃了 300 kcal」）。
 * 这里的规矩很硬：正文里出现的每个数字，要么在本地摘要里真实存在，要么属于允许的派生常量
 * （天数、组数、百分比、每周 7 天这类），否则标成「待核对」在界面上高亮出来。
 *
 * 守卫只标记、不删改：结论可以商量，数字不能悄悄改。
 */

import { MIN_COVERAGE_RATIO } from '@/domain/reportDigest'
import type { ReportContent, ReportDigest } from '@/domain/types'

/** 允许出现的派生常量：天/周/月换算、TDEE 取整步长、单位换算等。 */
const ALLOWED_CONSTANTS = [1, 2, 3, 4, 5, 6, 7, 10, 12, 14, 21, 28, 30, 31, 50, 90, 100, 365, 7700]
/** 百分比是唯一「不看白名单也放行」的形式：0-100 的整数 + 显式 `%`。 */
const PERCENT_RANGE = 100
const NUMBER_RE = /(\d+(?:\.\d+)?)(%?)/g

/** 把摘要里出现的每个数字收集成字符串，并附上它的四舍五入形态（模型常四舍五入后引用）。 */
function collectNumbers(value: unknown, into: Set<string>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(String(value))
    into.add(String(Math.round(value)))
    into.add(String(Math.round(value * 10) / 10))
    return
  }
  if (typeof value === 'string') {
    // 周期标签（2026-W41）、日期（2026-10-05）里的数字也算「摘要里出现过」
    for (const token of value.match(/\d+(?:\.\d+)?/g) ?? []) into.add(token)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectNumbers(item, into)
  }
}

/**
 * 任意「本地事实对象」里真实存在的数字集合。
 *
 * 报告传摘要，每日指导传「摘要 + 当日缺口」—— 白名单必须是同一个实现，
 * 否则同一句话在两处一个放行一个高亮（§6.4 / §6.4.2 共用一套数字守卫）。
 */
export function buildNumberWhitelistFrom(source: unknown): Set<string> {
  const numbers = new Set<string>()
  collectNumbers(source, numbers)
  return numbers
}

/** 摘要里真实存在的数字集合。 */
export function buildNumberWhitelist(digest: ReportDigest): Set<string> {
  return buildNumberWhitelistFrom(digest)
}

/**
 * 从一批正文里抽出数字 token，返回**不在白名单**的那些（去重，保持出现顺序）。
 *
 * 放行规则只有两种：数字在摘要里出现过，或者它是 `0-100%` 的百分比形式
 * （报告里写「达标 40%」比写「达标 40 天」常见得多）。
 *
 * 注意**不**放行「任意小整数」：`78 kg` 这种编造出来的体重正好落在 0-100 里，
 * 一旦放宽就全漏过去了。
 */
export function flagUnknownNumbersInTexts(texts: readonly string[], source: unknown): string[] {
  const whitelist = buildNumberWhitelistFrom(source)
  const flagged: string[] = []
  for (const text of texts) {
    for (const match of text.matchAll(NUMBER_RE)) {
      const token = match[1]
      const isPercent = match[2] === '%'
      if (whitelist.has(token)) continue
      const value = Number(token)
      if (isPercent && Number.isInteger(value) && value >= 0 && value <= PERCENT_RANGE) continue
      if (ALLOWED_CONSTANTS.includes(value)) continue
      if (!flagged.includes(token)) flagged.push(token)
    }
  }
  return flagged
}

/** 报告正文里所有会展示给用户的文字（守卫的扫描面）。 */
export function reportContentTexts(content: ReportContent): string[] {
  return [
    content.summary,
    ...content.training.notes,
    content.training.assessment,
    ...content.diet.notes,
    content.diet.assessment,
    ...content.recovery.notes,
    ...content.findings.map((item) => item.text),
    ...content.issues,
    ...content.actions,
    content.calibration.rationale,
    content.disclaimer
  ]
}

export function flagUnknownNumbers(content: ReportContent, digest: ReportDigest): string[] {
  return flagUnknownNumbersInTexts(reportContentTexts(content), digest)
}

/** 校准幅度门禁（FR-904）：`recommended=true` 且幅度超限时降级成待确认。 */
export const MAX_CALIBRATION_DELTA_KCAL = 150

export function applyCalibrationGate(content: ReportContent): {
  content: ReportContent
  notice?: string
} {
  if (!content.calibration.recommended) return { content }
  if (Math.abs(content.calibration.deltaKcal) <= MAX_CALIBRATION_DELTA_KCAL) return { content }
  const notice = `模型建议调整 ${content.calibration.deltaKcal} kcal，超过单次 ±${MAX_CALIBRATION_DELTA_KCAL} kcal 的上限（FR-904），已降级为「待确认」：请分次校准。`
  return {
    content: {
      ...content,
      calibration: { ...content.calibration, recommended: false, deltaKcal: 0 }
    },
    notice
  }
}

/** 覆盖率不足时不允许给校准建议（FR-707 / FR-708）。 */
export function applyCoverageGate(content: ReportContent, digest: ReportDigest): {
  content: ReportContent
  notice?: string
} {
  if (digest.coverage.ratio >= MIN_COVERAGE_RATIO || !content.calibration.recommended) return { content }
  return {
    content: {
      ...content,
      calibration: { ...content.calibration, recommended: false, deltaKcal: 0 }
    },
    notice: '样本不足（有记录天数不到一半），这次不给校准建议（FR-707 / FR-708）。'
  }
}
