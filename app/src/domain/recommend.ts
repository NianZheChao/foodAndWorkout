/**
 * 「生成式推荐」（B 级，T3.8）的安全边界与整理。纯计算，不碰库、不调模型。
 *
 * 两条口径：
 * 1. **默认关，而且开不了**：推荐会给出「今天吃什么」，也就可能推荐出用户不能吃的东西，
 *    所以 FR-1003 要求开启前必须先填齐忌口 / 过敏 / 可用器材 / 每餐时间四项约束。
 *    这里负责回答「齐没齐」；
 * 2. **约束是「已确认」而不是「可能有」**：没有忌口 / 过敏就填「无」。留空既表示不了「没有」，
 *    也看不出「还没填」—— 而分不清这两件事的推荐，正是不该被开启的那一种。
 */

import type { ProfileRecord, SettingsRecord } from './types'

export interface RecommendConstraintSpec {
  /** `ProfileRecord` 上的键 */
  key: 'avoidFoods' | 'allergies' | 'equipment' | 'mealMinutes'
  label: string
  /** 档案页的填写提示 */
  hint: string
}

export const RECOMMEND_CONSTRAINTS: readonly RecommendConstraintSpec[] = [
  { key: 'avoidFoods', label: '忌口', hint: '一行一条；没有就填「无」' },
  { key: 'allergies', label: '过敏', hint: '一行一条；没有就填「无」' },
  { key: 'equipment', label: '可用器材', hint: '一行一件；只有自重就填「自重」' },
  { key: 'mealMinutes', label: '每餐时间', hint: '每餐能投入的分钟数' }
]

/** 把多行 / 逗号 / 顿号分隔的输入拆成条目：用户怎么写都认，去空、去重、保序。 */
export function parseConstraintList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,，、;；]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.filter((item) => String(item).trim() !== '').length === 0
  if (typeof value === 'number') return !Number.isFinite(value) || value <= 0
  return false
}

/** 还没填的约束名（空数组 = 齐了，可以打开 B 级开关）。 */
export function missingRecommendConstraints(profile: ProfileRecord | undefined): string[] {
  if (!profile) return RECOMMEND_CONSTRAINTS.map((spec) => spec.label)
  return RECOMMEND_CONSTRAINTS.filter((spec) => isBlank(profile[spec.key])).map((spec) => spec.label)
}

export function recommendConstraintsReady(profile: ProfileRecord | undefined): boolean {
  return missingRecommendConstraints(profile).length === 0
}

/** B 级开关的读法：老数据没有这个键 = 关（默认关是这一档功能的设计前提）。 */
export function isRecommendEnabled(settings: SettingsRecord | undefined): boolean {
  return settings?.recommendEnabled === true
}

/**
 * 四项约束 → 给模型看的行（`plan.training` / `plan.meal` 的输入）。
 * 只发这些加上本地摘要，不发全量历史（FR-805）。
 */
export function recommendConstraintLines(profile: ProfileRecord | undefined): string[] {
  if (!profile) return []
  const lines: string[] = []
  for (const spec of RECOMMEND_CONSTRAINTS) {
    const value = profile[spec.key]
    const text = Array.isArray(value)
      ? value.filter((item) => String(item).trim() !== '').join(' / ')
      : value === undefined
        ? ''
        : String(value)
    lines.push(`${spec.label}：${text || '未填'}`)
  }
  return lines
}