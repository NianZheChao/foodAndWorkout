/**
 * 达标率。口径与 `scripts/nutrition.py` 的 `trend_summary` 一致：
 * - 热量：|摄入 − 目标| ≤ 目标 × 10%
 * - 蛋白：摄入 ≥ 目标 × 90%
 * - 分母一律是「有记录天数」，没记录的天不参与统计
 */

export const KCAL_TOLERANCE = 0.1
export const PROTEIN_TOLERANCE = 0.9

export function kcalHit(intakeKcal: number, targetKcal: number): boolean {
  if (!targetKcal || !intakeKcal) return false
  return Math.abs(intakeKcal - targetKcal) <= targetKcal * KCAL_TOLERANCE
}

export function proteinHit(intakeProteinG: number, targetProteinG: number): boolean {
  if (!targetProteinG) return false
  return intakeProteinG >= targetProteinG * PROTEIN_TOLERANCE
}

export interface HitRate {
  hit: number
  total: number
  /** 0-1；分母为 0 时为 undefined */
  ratio?: number
}

export function hitRate(flags: readonly boolean[]): HitRate {
  const total = flags.length
  const hit = flags.filter(Boolean).length
  return { hit, total, ratio: total ? hit / total : undefined }
}

