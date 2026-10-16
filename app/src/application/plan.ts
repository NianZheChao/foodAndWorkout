/**
 * 生成式推荐（B 级，T3.8）的用例层：§6.5 / §6.6 的两个任务。
 *
 * 分工与报告 / 指导一致，只是**多了一道开关**：
 * 1. **门禁**：开关必须开着、四项约束必须齐（FR-1003）—— 未满足时整条链路不可用，不是「提示一下」；
 * 2. **输入全部本地构造**：缺口、肌群账、上次同动作的写法、常用食材名（只给名称，FR-805）；
 * 3. **输出过本地复核**：器材白名单 / +10% 加重 / 时长（训练），按食物库重算克数与营养（FR-806）；
 * 4. **同日缓存**：输入指纹没变就复用当天那一条，只有重新生成才覆盖（FR-1409 / §6.2）。
 *
 * 模型失败**不落库**（也不覆盖已有那一版）：推荐是给人照着做的清单，错了没有补救的机会。
 */

import { addDays } from '@/app/date'
import { listDaysInRange } from '@/data/repositories/days'
import { listFoods } from '@/data/repositories/foods'
import { listIntakeInRange, newId } from '@/data/repositories/intake'
import { getPlan, listPlans, putPlan } from '@/data/repositories/plans'
import { getProfile } from '@/data/repositories/profile'
import { getSettings } from '@/data/repositories/settings'
import { getTargets } from '@/data/repositories/targets'
import { listWorkoutInRange } from '@/data/repositories/workout'
import { fingerprintOf } from '@/domain/fingerprint'
import { sumFacts } from '@/domain/nutrition'
import {
  buildFoodIndex,
  RECOVERY_HOURS,
  recomputeMealPlan,
  reviewTrainingPlan,
  type PlanMealGap,
  type PlanMealOutput,
  type PlanTrainingOutput,
  type TrainingPlanContext
} from '@/domain/plan'
import { isRecommendEnabled, missingRecommendConstraints, recommendConstraintLines } from '@/domain/recommend'
import { buildHints } from '@/domain/targets'
import { muscleRecency, recentExerciseLoads } from '@/domain/training'
import { runTask, type LlmTask, type RunFailure, type RunOptions } from '@/llm'
import { planMealTask, planTrainingTask, type PlanMealInput, type PlanTrainingInput } from '@/llm/tasks/plan'
import { loadDigestTargets } from './report'
import type { MealPlanRecord, PlanRecord, PlanRecordBase, TrainingPlanRecord } from '@/domain/types'

/** 推荐看的窗口：近 14 天（§6.5 的「近 14 天各肌群组数与最近训练时间」）。 */
export const PLAN_WINDOW_DAYS = 14
/** 常用食材名最多给几个（只给名字，不给数值；FR-805）。 */
export const PLAN_COMMON_FOODS = 20
/** 没有历史记录时，从食物库里挑高蛋白条目兜底的上限。 */
export const PROTEIN_FOOD_FALLBACK = 20
/** 生成结果 id 的前缀；两类计划各自独立。 */
const PLAN_ID_PREFIX = { training: 'planT', meal: 'planM' } as const

export interface PlanGate {
  /** `settings.recommendEnabled`（老数据没有这个键 = 关） */
  enabled: boolean
  /** 还没填的安全边界（忌口 / 过敏 / 可用器材 / 每餐时间） */
  missing: string[]
}

/**
 * 门禁原因；`undefined` = 可以生成。
 *
 * 两条都是「整条链路不可用」而不是软提示：FR-1003 写的是「否则不得开启」，
 * 所以应用层要再判一次，不能只靠界面把开关禁用。
 */
export function gateMessage(gate: PlanGate): string | undefined {
  const parts: string[] = []
  if (!gate.enabled) {
    parts.push('生成式推荐（B 级）默认关：它会给具体的「今天练什么 / 今天吃什么」，先到「设置 → 生成式推荐」把开关打开')
  }
  if (gate.missing.length) {
    // 没打开开关时也把缺的约束列出来：两件事都要做，一次说清省得用户跑两趟
    parts.push(
      `开推荐之前必须先补齐安全边界（FR-1003）：${gate.missing.join(' / ')} —— 去「档案」页填上；没有忌口 / 过敏就填「无」，别留空`
    )
  }
  return parts.length ? parts.join('；') : undefined
}

/** 常用食材名：近 14 天记过的（按次数降序取前 20）；没有历史时用库里蛋白最高的条目兜底。 */
export async function commonFoodNames(rows: readonly { foodSnapshot: { name: string } }[]): Promise<string[]> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const name = row.foodSnapshot?.name
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size) {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, PLAN_COMMON_FOODS)
      .map(([name]) => name)
  }
  const foods = await listFoods()
  return foods
    .filter((food) => food.disabledFlag !== 1 && food.proteinG >= 10)
    .sort((a, b) => b.proteinG - a.proteinG || (a.name < b.name ? -1 : 1))
    .slice(0, PROTEIN_FOOD_FALLBACK)
    .map((food) => food.name)
}

export interface PlanContext {
  date: string
  windowStart: string
  gate: PlanGate
  /** 今天的缺口（两个任务共用；页面上「还差多少」也是它） */
  gap: PlanMealGap
  /** 今天的缺口提示（与今日页 / 指导页同源，不需要模型） */
  localHints: string[]
  training: PlanTrainingInput
  meal: PlanMealInput
  fingerprints: { training: string; meal: string }
}

/**
 * 组装两个推荐任务的输入。
 *
 * 输入里**没有一条原始记录**：肌群账、缺口、上次同动作的写法都是本地算完的结果，
 * 食材只给名称（FR-805 / DR-40）。开关关着时也照常组装 —— 页面要能说清「开了之后会发什么」。
 */
export async function buildPlanContext(date: string): Promise<PlanContext> {
  const windowStart = addDays(date, -(PLAN_WINDOW_DAYS - 1))
  const [settings, profile, targets, digestTargets, dayRows, intakeRows, workoutRows] = await Promise.all([
    getSettings(),
    getProfile(),
    getTargets(),
    loadDigestTargets(),
    listDaysInRange(windowStart, date),
    listIntakeInRange(windowStart, date),
    listWorkoutInRange(windowStart, date)
  ])

  const gate: PlanGate = {
    enabled: isRecommendEnabled(settings),
    missing: missingRecommendConstraints(profile)
  }
  const constraints = recommendConstraintLines(profile)

  const facts = sumFacts(intakeRows.filter((row) => row.date === date).map((row) => row.computed))
  const dayRow = dayRows.find((row) => row.date === date)
  // 没设目标就没有「还差多少」：留空，不补 0（补 0 会被模型当成事实引用）
  const remainingKcal = targets?.kcalTarget ? Math.round(targets.kcalTarget - facts.kcal) : undefined
  const remainingProteinG = targets?.proteinTargetG ? Math.round(targets.proteinTargetG - facts.proteinG) : undefined
  const gap: PlanMealGap = {
    remainingKcal,
    remainingProteinG,
    sodiumMaxMg: targets?.sodiumMaxMg || undefined,
    sodiumSoFarMg: Math.round(facts.sodiumMg),
    fiberTargetG: targets?.fiberTargetG || undefined,
    fiberSoFarG: Math.round(facts.fiberG)
  }

  const muscles = muscleRecency(workoutRows, date)
  const recent = recentExerciseLoads(workoutRows)
  const training: PlanTrainingInput = {
    date,
    today: {
      kcalSoFar: Math.round(facts.kcal),
      proteinSoFarG: Math.round(facts.proteinG),
      remainingKcal,
      remainingProteinG,
      // 拉伸不算「今天练了」，与容量口径一致
      trainedToday: workoutRows.some((row) => row.date === date && row.type !== '拉伸'),
      weightAmKg: dayRow?.weightAmKg
    },
    muscles: muscles.map((row) => ({ muscle: row.muscle, sets: row.sets, hoursSinceLast: row.hoursSinceLast })),
    targets: {
      setsPerMuscle: digestTargets.weeklySetsPerMuscle ?? 0,
      trainingDays: digestTargets.weeklyTrainingDays ?? 0
    },
    recent: recent.map((row) => ({ exercise: row.exercise, date: row.date, volume: row.volume })),
    constraints,
    needsRecovery: muscles
      .filter((row) => row.hoursSinceLast !== undefined && row.hoursSinceLast < RECOVERY_HOURS)
      .map((row) => row.muscle)
  }

  const meal: PlanMealInput = {
    date,
    gap: {
      remainingKcal,
      remainingProteinG,
      sodiumMaxMg: gap.sodiumMaxMg,
      sodiumSoFarMg: gap.sodiumSoFarMg,
      sodiumOverLimit: !!targets?.sodiumMaxMg && facts.sodiumMg > targets.sodiumMaxMg,
      fiberTargetG: gap.fiberTargetG,
      fiberSoFarG: gap.fiberSoFarG
    },
    constraints,
    commonFoods: await commonFoodNames(intakeRows)
  }

  return {
    date,
    windowStart,
    gate,
    gap,
    // 与今日页 / 指导页同源的缺口提示：目标缺省时这里已经补成 0，不会是 undefined
    localHints: buildHints(facts, digestTargets),
    training,
    meal,
    fingerprints: { training: fingerprintOf(training), meal: fingerprintOf(meal) }
  }
}

/** 复核训练计划要用到的本地事实（器材、上次写法、恢复窗口）。 */
export async function buildTrainingContext(equipment: string[], date: string): Promise<TrainingPlanContext> {
  const windowStart = addDays(date, -(PLAN_WINDOW_DAYS - 1))
  const workouts = await listWorkoutInRange(windowStart, date)

  const lastByExercise = new Map<string, { weightKg?: number; date: string; volume: string }>()
  // 比输入宽一点（30 条）：输入只发 12 条省 token，本地复核要尽量认得出来
  for (const row of recentExerciseLoads(workouts, 30)) {
    lastByExercise.set(row.exercise.trim().toLowerCase(), { weightKg: row.weightKg, date: row.date, volume: row.volume })
  }
  const hoursSinceMuscle = new Map<string, number>()
  for (const row of muscleRecency(workouts, date)) {
    if (row.hoursSinceLast !== undefined) hoursSinceMuscle.set(row.muscle, row.hoursSinceLast)
  }
  return { equipment, lastByExercise, hoursSinceMuscle }
}

export interface PlanOutcome<R extends PlanRecord = PlanRecord> {
  ok: boolean
  /** 门禁原因；有值时 `ok` 必为 false */
  blocked?: string
  record?: R
  /** true = 命中当日缓存，这次没有调用模型 */
  cached?: boolean
  failure?: Pick<RunFailure, 'kind' | 'message' | 'retriable'>
  notices: string[]
}

export interface GeneratePlanInput {
  date: string
  /** true = 用户手动刷新：输入没变也再问一次模型 */
  force?: boolean
}

/**
 * 两个任务的公用骨架：门禁 → 缓存 → 请求 → 本地复核 → 落库。
 *
 * 复核（`build`）必须在**写库之前**发生：被剔除的动作、按库重算出来的数值都要一起落库，
 * 否则页面看到的就不是「复核过的结果」，而是模型的原文 —— 那正是 FR-806 要避免的。
 */
async function runPlanTask<In, Out, R extends PlanRecord>(
  args: {
    kind: R['kind']
    task: LlmTask<In, Out>
    input: In
    fingerprint: string
    build: (value: Out, base: PlanRecordBase) => R | Promise<R>
  },
  input: GeneratePlanInput,
  gate: PlanGate,
  options: RunOptions
): Promise<PlanOutcome<R>> {
  const blocked = gateMessage(gate)
  if (blocked) return { ok: false, blocked, notices: [] }

  const existing = await getPlan(input.date, args.kind)
  if (existing && existing.fingerprint === args.fingerprint && !input.force) {
    return { ok: true, record: existing as R, cached: true, notices: existing.notices ?? [] }
  }

  const result = await runTask(args.task, args.input, options)
  if (!result.ok) {
    return {
      ok: false,
      failure: { kind: result.kind, message: result.message, retriable: result.retriable },
      notices: []
    }
  }

  const now = Date.now()
  const record = await args.build(result.value, {
    id: existing?.id ?? newId(PLAN_ID_PREFIX[args.kind]),
    date: input.date,
    fingerprint: args.fingerprint,
    model: result.model,
    taskVersion: args.task.version,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
  await putPlan(record)
  return { ok: true, record, notices: record.notices ?? [] }
}

/** 「今天练什么」（FR-801）。 */
export async function generateTrainingPlan(
  input: GeneratePlanInput,
  options: RunOptions = {}
): Promise<PlanOutcome<TrainingPlanRecord>> {
  const [context, profile] = await Promise.all([buildPlanContext(input.date), getProfile()])
  return runPlanTask<PlanTrainingInput, PlanTrainingOutput, TrainingPlanRecord>(
    {
      kind: 'training',
      task: planTrainingTask,
      input: context.training,
      fingerprint: context.fingerprints.training,
      build: async (value, base) => {
        const review = reviewTrainingPlan(value, await buildTrainingContext(profile?.equipment ?? [], input.date))
        return { ...base, kind: 'training', content: review.content, notices: review.notices }
      }
    },
    input,
    context.gate,
    options
  )
}

/** 「今天还能吃什么」（FR-802）。 */
export async function generateMealPlan(
  input: GeneratePlanInput,
  options: RunOptions = {}
): Promise<PlanOutcome<MealPlanRecord>> {
  const context = await buildPlanContext(input.date)
  return runPlanTask<PlanMealInput, PlanMealOutput, MealPlanRecord>(
    {
      kind: 'meal',
      task: planMealTask,
      input: context.meal,
      fingerprint: context.fingerprints.meal,
      build: async (value, base) => {
        const recompute = recomputeMealPlan(value, buildFoodIndex(await listFoods()))
        return { ...base, kind: 'meal', content: recompute.content, notices: recompute.notices }
      }
    },
    input,
    context.gate,
    options
  )
}

/** 读某一天已经生成过的两条推荐（页面加载用，不触发任何调用）。 */
export async function loadPlanRecords(
  date: string
): Promise<{ training?: TrainingPlanRecord; meal?: MealPlanRecord }> {
  const rows = await listPlans(date)
  return {
    training: rows.find((row): row is TrainingPlanRecord => row.kind === 'training'),
    meal: rows.find((row): row is MealPlanRecord => row.kind === 'meal')
  }
}

