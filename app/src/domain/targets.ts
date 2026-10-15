/**
 * 目标对比、差额、占比与缺口提示。
 *
 * 提示文案与 `scripts/nutrition.py` 的 `summary_lines` 逐字对齐——脚本是验收基准
 * （docs/pwa-design.md §5.3），对拍测试会直接比对文案。
 */

import { NUTRIENT_LABELS, NUTRIENT_UNITS } from '@/domain/nutrition'
import type { DaySummary, DaySummaryRow, NutritionFacts, TargetsRecord } from '@/domain/types'

export type TargetValues = Pick<
  TargetsRecord,
  | 'kcalTarget'
  | 'proteinTargetG'
  | 'fatTargetG'
  | 'carbTargetG'
  | 'fiberTargetG'
  | 'sodiumMaxMg'
>

interface TargetSpec {
  key: DaySummaryRow['key']
  intake: (facts: NutritionFacts) => number
  target: (targets: TargetValues) => number
  /** `max` 表示这是上限，超了才算问题 */
  mode: 'goal' | 'max'
}

const SPECS: TargetSpec[] = [
  { key: 'kcal', intake: (f) => f.kcal, target: (t) => t.kcalTarget, mode: 'goal' },
  { key: 'proteinG', intake: (f) => f.proteinG, target: (t) => t.proteinTargetG, mode: 'goal' },
  { key: 'fatG', intake: (f) => f.fatG, target: (t) => t.fatTargetG, mode: 'goal' },
  { key: 'carbG', intake: (f) => f.carbG, target: (t) => t.carbTargetG, mode: 'goal' },
  { key: 'fiberG', intake: (f) => f.fiberG, target: (t) => t.fiberTargetG, mode: 'goal' },
  { key: 'sodiumMg', intake: (f) => f.sodiumMg, target: (t) => t.sodiumMaxMg, mode: 'max' }
]

export function buildSummaryRows(intake: NutritionFacts, targets: TargetValues): DaySummaryRow[] {
  return SPECS.map((spec) => {
    const got = spec.intake(intake)
    const want = spec.target(targets)
    return {
      key: spec.key,
      label: `${NUTRIENT_LABELS[spec.key]}(${NUTRIENT_UNITS[spec.key]})`,
      intake: got,
      target: want,
      diff: got - want,
      ratio: want ? got / want : 0
    }
  })
}

/**
 * 缺口提示文案。与脚本 `summary_lines` 的 notes 顺序、措辞、阈值完全一致。
 */
export function buildHints(intake: NutritionFacts, targets: TargetValues): string[] {
  const hints: string[] = []
  const kcalTarget = targets.kcalTarget
  if (kcalTarget && intake.kcal) {
    const ratio = intake.kcal / kcalTarget
    if (ratio > 1.1) {
      hints.push(`热量超出目标 ${Math.round((ratio - 1) * 100)}%，若为计划内的高热量日请忽略`)
    } else if (ratio < 0.7) {
      hints.push(`热量明显低于目标（${Math.round(ratio * 100)}%），长期过低会掉肌肉并降低 TDEE`)
    }
  }
  const proteinTarget = targets.proteinTargetG
  if (proteinTarget && intake.proteinG < proteinTarget * 0.9) {
    hints.push(`蛋白质差 ${Math.round(proteinTarget - intake.proteinG)} g，优先补乳清、鸡胸、蛋、脱脂奶`)
  }
  const sodiumMax = targets.sodiumMaxMg
  if (sodiumMax && intake.sodiumMg > sodiumMax) {
    hints.push(`钠超出上限 ${Math.round(intake.sodiumMg - sodiumMax)} mg，注意酱油、加工肉、外食`)
  }
  const fiberTarget = targets.fiberTargetG
  if (fiberTarget && intake.fiberG < fiberTarget) {
    hints.push(`纤维差 ${Math.round(fiberTarget - intake.fiberG)} g，加蔬菜、燕麦或豆类`)
  }
  return hints
}

export interface DaySummaryInput {
  date: string
  intake: NutritionFacts
  targets: TargetValues
  weightAmKg?: number
  weightPmKg?: number
  training: DaySummary['training']
  /** 待补全条目数（模型未配置 / 断网时的占位）；>0 时汇总标记为不完整 */
  pendingCount: number
  computedAt: number
}

/** 当日汇总：行 + 提示 + 完整性标记。 */
export function buildDaySummary(input: DaySummaryInput): DaySummary {
  return {
    date: input.date,
    rows: buildSummaryRows(input.intake, input.targets),
    weightAmKg: input.weightAmKg,
    weightPmKg: input.weightPmKg,
    training: input.training,
    incomplete: input.pendingCount > 0,
    pendingCount: input.pendingCount,
    hints: buildHints(input.intake, input.targets),
    computedAt: input.computedAt
  }
}

