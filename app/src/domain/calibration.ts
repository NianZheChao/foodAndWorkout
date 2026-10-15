/**
 * 首次估算与校准：Mifflin-St Jeor BMR → 活动系数 → 阶段调整 → 宏量目标。
 *
 * 口径与 `scripts/nutrition.py` 的 `cmd_init` 完全一致（含 Python 的
 * round-half-even 取整，避免与 targets.md 的既有数值出现 ±1 的漂移）。
 */

import { KCAL_PER_KG, roundToTdeeStep, TDEE_STEP } from '@/domain/tdee'
import { isPlausibleWeight, trendWeight, type WeightLike } from '@/domain/weight'
import type { ProfileRecord, TargetsRecord } from '@/domain/types'

/** Python `round()` 的 half-even 语义。 */
export function pyRound(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5 + 1e-9) return floor + 1
  if (diff < 0.5 - 1e-9) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

export function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits
  return pyRound(value * factor) / factor
}

export interface BmrInput {
  sex: 'male' | 'female'
  weightKg: number
  heightCm: number
  age: number
}

/** Mifflin-St Jeor：10×体重 + 6.25×身高 − 5×年龄 + (男 +5 / 女 −161)。 */
export function mifflinStJeorBmr({ sex, weightKg, heightCm, age }: BmrInput): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161)
}

export interface ActivityFactor {
  factor: number
  label: string
}

/** 活动系数与脚本 `activity_factor` 一致。 */
export function activityFactor(weeklyTrainingDays: number): ActivityFactor {
  if (weeklyTrainingDays <= 0) return { factor: 1.2, label: '久坐' }
  if (weeklyTrainingDays <= 2) return { factor: 1.375, label: '轻度（每周 1-2 练）' }
  if (weeklyTrainingDays <= 4) return { factor: 1.55, label: '中度（每周 3-4 练）' }
  if (weeklyTrainingDays <= 6) return { factor: 1.725, label: '活跃（每周 5-6 练）' }
  return { factor: 1.9, label: '非常活跃（每周 7 练）' }
}

export type Phase = '减脂' | '增肌' | '重组' | '维持'

/** 由目标文本判定阶段与热量调整幅度（脚本 `classify_goal`）。 */
export function classifyGoal(goalText: string | undefined): { phase: Phase; adjust: number } {
  const value = goalText ?? ''
  if (value.includes('减脂') && value.includes('增肌')) return { phase: '重组', adjust: -0.1 }
  if (value.includes('减脂')) return { phase: '减脂', adjust: -0.15 }
  if (value.includes('增肌')) return { phase: '增肌', adjust: 0.1 }
  return { phase: '维持', adjust: 0 }
}

/** 未填每周训练天数时按训练水平推定（脚本同口径）。 */
export function inferWeeklyTrainingDays(trainingLevel: string | undefined): number {
  const level = trainingLevel ?? ''
  if (level.includes('新')) return 3
  if (level.includes('高')) return 5
  return 4
}

export function inferWeeklySetsPerMuscle(trainingLevel: string | undefined): number {
  const level = trainingLevel ?? ''
  if (level.includes('高')) return 18
  if (level.includes('新')) return 10
  return 14
}

export type InitialTargets = Omit<TargetsRecord, 'id' | 'updatedAt' | 'lastCalibrated'> & {
  bmr: number
  tdeeKcal: number
  phase: Phase
  adjust: number
  activityLabel: string
}

export interface InitialTargetsInput {
  profile: Pick<ProfileRecord, 'sex' | 'age' | 'heightCm' | 'goal' | 'trainingLevel'>
  weightKg: number
  /** 已存在的 targets 里的每周训练天数；缺省时按训练水平推定 */
  weeklyTrainingDays?: number
  reviewCadence?: TargetsRecord['reviewCadence']
}

/**
 * 首次估算：BMR → TDEE → 热量目标 → 蛋白 / 脂肪 / 碳水。
 * 蛋白 2.0 g/kg（减脂 / 重组）、1.8（增肌）、1.6（维持）；脂肪 0.8 g/kg；碳水补足余量。
 */
export function buildInitialTargets(input: InitialTargetsInput): InitialTargets {
  const { profile, weightKg } = input
  const bmr = mifflinStJeorBmr({
    sex: profile.sex,
    weightKg,
    heightCm: profile.heightCm,
    age: profile.age
  })
  const weeklyTrainingDays = input.weeklyTrainingDays || inferWeeklyTrainingDays(profile.trainingLevel)
  const { factor, label } = activityFactor(weeklyTrainingDays)
  const tdeeKcal = bmr * factor
  const { phase, adjust } = classifyGoal(profile.goal)
  const kcalTarget = pyRound((tdeeKcal * (1 + adjust)) / 10) * 10
  const proteinFactor = phase === '减脂' || phase === '重组' ? 2.0 : phase === '增肌' ? 1.8 : 1.6
  const proteinTargetG = pyRound(proteinFactor * weightKg)
  const fatTargetG = pyRound(0.8 * weightKg)
  const carbTargetG = pyRound((kcalTarget - proteinTargetG * 4 - fatTargetG * 9) / 4 / 5) * 5
  const targetRateKgPerWeek = roundTo(((kcalTarget - tdeeKcal) * 7) / KCAL_PER_KG, 2)
  return {
    bmr,
    tdeeKcal,
    phase,
    adjust,
    activityLabel: label,
    kcalTarget,
    proteinTargetG,
    fatTargetG,
    carbTargetG,
    fiberTargetG: 30,
    sodiumMaxMg: 2300,
    weeklyTrainingDays,
    weeklySetsPerMuscle: inferWeeklySetsPerMuscle(profile.trainingLevel),
    targetWeightKg: 0,
    targetRateKgPerWeek,
    reviewCadence: input.reviewCadence ?? 'weekly'
  }
}

/** 单次校准允许的热量调整上限（T3.5：超出 ±150 kcal 要拦下）。 */
export const MAX_CALIBRATION_KCAL = 150

export interface CalibrationProposal {
  /** 建议的新热量目标（50 的整数倍） */
  kcalTarget: number
  deltaKcal: number
  /** 是否被幅度门禁拦下 */
  clamped: boolean
  note?: string
}

/**
 * 由实测 TDEE 与目标速率给出新的热量目标，并按 ±150 kcal 门禁限幅。
 */
export function proposeCalibration(
  measuredTdeeKcal: number,
  currentKcalTarget: number,
  targetRateKgPerWeek: number
): CalibrationProposal {
  const suggested = roundToTdeeStep(measuredTdeeKcal + (targetRateKgPerWeek * KCAL_PER_KG) / 7)
  const raw = suggested - currentKcalTarget
  const clamped = Math.abs(raw) > MAX_CALIBRATION_KCAL
  const limited = clamped
    ? currentKcalTarget + Math.sign(raw) * MAX_CALIBRATION_KCAL
    : suggested
  const kcalTarget = clamped ? roundToTdeeStep(limited) : suggested
  return {
    kcalTarget,
    deltaKcal: kcalTarget - currentKcalTarget,
    clamped,
    note: clamped
      ? `单次调整超过 ±${MAX_CALIBRATION_KCAL} kcal，已按上限调整；建议分次校准。`
      : undefined
  }
}

/** 由 TDEE 与目标速率直接反推热量（用于展示「目标速率对应热量」）。 */
export function kcalForRate(tdeeKcal: number, rateKgPerWeek: number): number {
  return tdeeKcal + (rateKgPerWeek * KCAL_PER_KG) / 7
}

/**
 * 首次估算用哪个体重：最近一条记录的体重 → profile.md 的体重 → 无。
 *
 * 注意与脚本的差异：`nutrition.py init` 只认记录的旧字段 `weight_kg`（新记录早已改用
 * `weight_am_kg`），所以它几乎总是退回 profile.md。应用里以「最近一次真实称重」为准更合理，
 * 因此这里优先晨重、其次睡前重、最后才用 profile.md。
 */
export function resolveSeedWeight(
  days: readonly WeightLike[],
  profileWeightKg?: number
): { weightKg?: number; from: string } {
  const ordered = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const day = ordered[index]
    const { value } = trendWeight(day)
    if (value !== undefined) return { weightKg: value, from: `最近记录 ${day.date}` }
    if (isPlausibleWeight(day.weightPmKg)) {
      return { weightKg: day.weightPmKg, from: `最近记录 ${day.date}（睡前重）` }
    }
  }
  if (isPlausibleWeight(profileWeightKg)) return { weightKg: profileWeightKg, from: 'profile.md' }
  return { from: '' }
}

export { TDEE_STEP }
