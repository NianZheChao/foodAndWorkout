/**
 * 每日指导的本地闸门（T3.7 / §6.4.2）。
 *
 * A 级指导与报告守同一套底线：数字只能来自本地摘要，建议必须能追溯到具体字段。
 * 这里只放**纯函数** —— 依据校验、样本门禁、数字守卫的扫描面、缓存指纹、历史建议整理；
 * 拼输入与调模型在 `application/coach.ts`。
 *
 * 为什么依据校验要做得这么硬：模型很容易写「你这周吃得太少了」这种没有出处的漂亮话。
 * 允许它进界面，就等于把「本地数据说话」这条产品底线让掉了（NFR-13）。
 */

import { MIN_COVERAGE_RATIO } from '@/domain/reportDigest'
import { flagUnknownNumbersInTexts } from '@/domain/reportGuard'
import type { AdviceRecord, CoachAdviceItem, CoachContent, CoachTodayGap, ReportDigest } from '@/domain/types'

/** `basis` 里这个前缀表示「当日缺口」，其余路径相对摘要（§6.4.2 的 `intake.avgProteinG` 写法）。 */
export const TODAY_BASIS_PREFIX = 'today.'

export interface CoachSource {
  digest: ReportDigest
  today: CoachTodayGap
}

/**
 * 读一条 basis 路径。
 *
 * 缺失、路径穿不过去、值是 `undefined` 都算命中不了 —— NFR-13 要的是「真实存在的字段」，
 * 不是「看起来像字段名的字符串」。摘要里空值一律留空（不是 0），所以这里也必须拒绝空值。
 */
export function resolveBasisPath(source: CoachSource, path: string): { ok: boolean; value?: unknown } {
  const trimmed = path.trim()
  if (!trimmed) return { ok: false }
  const fromToday = trimmed.startsWith(TODAY_BASIS_PREFIX)
  const segments = (fromToday ? trimmed.slice(TODAY_BASIS_PREFIX.length) : trimmed).split('.').filter(Boolean)
  if (!segments.length) return { ok: false }

  let cursor: unknown = fromToday ? source.today : source.digest
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return { ok: false }
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return { ok: false }
      cursor = cursor[index]
      continue
    }
    const bag = cursor as Record<string, unknown>
    if (!(segment in bag)) return { ok: false }
    cursor = bag[segment]
  }
  return cursor === undefined ? { ok: false } : { ok: true, value: cursor }
}

/** 命中的依据路径（至少一条才算「有依据」）。 */
export function validBasisPaths(source: CoachSource, basis: readonly string[]): string[] {
  return basis.map((path) => path.trim()).filter((path) => path && resolveBasisPath(source, path).ok)
}

/**
 * 「调整目标」类建议：依据落在当前目标 / TDEE 上。
 *
 * 覆盖率不足时这类建议不出（§6.4.2 的样本门禁）：样本不够时算出来的「该调多少」正是最危险的那种数。
 */
const TARGET_BASIS_PREFIXES = ['currentTargets.', 'tdee.']

export function isTargetChangeAdvice(item: CoachAdviceItem): boolean {
  return item.basis.some((path) => {
    const trimmed = path.trim()
    return TARGET_BASIS_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  })
}

export interface CoachGateResult {
  content: CoachContent
  notices: string[]
  /** 被丢掉、没有展示的建议原文（条数与原文都留痕，界面要能说明） */
  dropped: string[]
}

function withoutAdvice(content: CoachContent, kept: CoachAdviceItem[]): CoachContent {
  return { ...content, advice: kept }
}

/** 依据校验（NFR-13）：basis 一条都命不中就整条不展示。命中的路径顺便收敛成规范写法。 */
export function applyBasisGate(content: CoachContent, source: CoachSource): CoachGateResult {
  const kept: CoachAdviceItem[] = []
  const dropped: string[] = []
  for (const item of content.advice) {
    const hit = validBasisPaths(source, item.basis)
    if (!hit.length) {
      dropped.push(item.text)
      continue
    }
    kept.push({ ...item, basis: hit })
  }
  return {
    content: withoutAdvice(content, kept),
    dropped,
    notices: dropped.length
      ? [`有 ${dropped.length} 条建议在本地数字里找不到依据，已按 NFR-13 去掉：${dropped.join('；')}`]
      : []
  }
}

/** 样本门禁：覆盖率低于一半时，标题强制带「样本不足」，并去掉调整目标类建议。 */
export const SAMPLE_WARNING = '样本不足：'

export function applyCoachCoverageGate(content: CoachContent, digest: ReportDigest): CoachGateResult {
  if (digest.coverage.ratio >= MIN_COVERAGE_RATIO) return { content, notices: [], dropped: [] }
  const droppedItems = content.advice.filter(isTargetChangeAdvice)
  const headline = content.headline.startsWith(SAMPLE_WARNING)
    ? content.headline
    : `${SAMPLE_WARNING}${content.headline}`
  return {
    content: {
      ...withoutAdvice(
        content,
        content.advice.filter((item) => !isTargetChangeAdvice(item))
      ),
      headline
    },
    dropped: droppedItems.map((item) => item.text),
    notices: [
      `近 ${digest.period.days} 天里只有 ${digest.coverage.daysWithIntake} 天有饮食记录（样本不足），` +
        '标题已标出，并去掉了调整目标类建议（FR-707 / FR-708）。'
    ]
  }
}

/** 指导里所有会展示给用户的文字（数字守卫的扫描面）。 */
export function coachContentTexts(content: CoachContent): string[] {
  return [
    content.headline,
    ...content.advice.map((item) => item.text),
    ...content.focus,
    ...content.ask,
    content.disclaimer
  ]
}

/** 数字守卫：白名单来自「摘要 + 当日缺口」，与报告共用实现。 */
export function flagCoachNumbers(content: CoachContent, source: CoachSource): string[] {
  return flagUnknownNumbersInTexts(coachContentTexts(content), source)
}

/** 稳定序列化：键排序后输出，保证同样的数据得到同样的指纹（键序不该影响缓存判断）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/**
 * 缓存指纹（§6.4.2「频率与缓存」）：同一天数据没变就复用今天那一版，不重复调用模型。
 * djb2：不是密码学哈希，只要「数据变了指纹就变、没变就一样」够用。
 */
export function coachFingerprint(source: CoachSource): string {
  const text = stableStringify(source)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** `history.advice` 的一条：只带用户**表过态**的建议。 */
export interface CoachHistoryAdvice {
  date: string
  text: string
  adopted: boolean
}

export const COACH_HISTORY_LIMIT = 5

/**
 * 从历史指导里整理出 `history.advice`。
 *
 * 只收「采纳 / 不采纳」表过态的条目：没表态的既不能说明有效，也不能说明没用，只是噪声。
 * 同一句话只留最近一次表态，取最近若干条后翻回升序 —— 模型读到的是一条时间线。
 */
export function buildCoachHistory(
  records: readonly AdviceRecord[],
  limit: number = COACH_HISTORY_LIMIT
): CoachHistoryAdvice[] {
  const seen = new Set<string>()
  const collected: CoachHistoryAdvice[] = []
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date))
  for (const record of sorted) {
    for (const item of record.content.advice) {
      if (typeof item.adopted !== 'boolean') continue
      const text = item.text.trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      collected.push({ date: record.date, text, adopted: item.adopted })
    }
  }
  return collected.slice(0, limit).reverse()
}
