/**
 * 推荐（B 级，T3.8）的本地加工：纯计算，不碰库、不调模型。
 *
 * 三条纪律，都是「确定性计算一律本地算」（DR-45 / FR-1410）在这一档功能上的具体形状：
 * 1. **数值本地复算**（FR-806）：食材克数 × 食物库 = 展示的合计。模型自报的 `totalsPreview`
 *    只用来比对，永远不进界面；
 * 2. **安全边界本地兜底**（FR-801 / FR-803）：用档案里没有的器材的动作剔除，加重超过 +10% 的
 *    标出来让人确认。「家里有什么」不进请求，所以这类判定只能在这里做；
 * 3. **对照缺口本地算**（FR-802）：推荐吃了一顿之后离目标还差多少，是本地的减法，不是模型的。
 *
 * 这里只做「模型输出 → 可展示、可落库的内容」，拼输入与调模型在 `application/plan.ts`。
 */

import { baseNameOf, normalizeFoodName } from './foodName'
import { factsForGrams, sumFacts } from './nutrition'
import type {
  Food,
  NutritionFacts,
  PlanMealContent,
  PlanMealLine,
  PlanTrainingContent,
  PlanTrainingExercise,
  ShoppingItem
} from './types'

/** 模型自报的合计与本地重算偏差超过这个比例就提示（§6.6）。 */
export const PREVIEW_TOLERANCE = 0.15
/** 48 小时内练过的肌群算「还没恢复」（FR-801）。按天粒度算，所以是「今天 + 昨天」。 */
export const RECOVERY_HOURS = 48
/** 单次加重超过上次的 10% 就提示确认（§6.5 的本地处理）。 */
export const WEIGHT_STEP_LIMIT = 0.1
/** 本地估时长：每组按 3 分钟（含组间休息）+ 热身 8 分钟。 */
export const MINUTES_PER_SET = 3
export const WARMUP_MINUTES = 8
/** 单组时长与模型自报偏差超过这个比例就提示。 */
export const DURATION_TOLERANCE = 0.25

/** 训练计划的契约输出（模型给的那一份，未经本地复核）。 */
export interface PlanTrainingOutput {
  focus: string
  estimatedMinutes: number
  exercises: PlanTrainingExercise[]
  notes: string[]
}

/** 食谱的契约输出（`totalsPreview` 是模型自报的，本地只用来比对）。 */
export interface PlanMealOutput {
  title: string
  items: { food: string; grams: number; dish?: string }[]
  seasonings?: { food: string; grams: number; dish?: string }[]
  totalsPreview?: { kcal: number; proteinG: number; fatG: number; carbG: number }
  shoppingList?: ShoppingItem[]
}

/**
 * 食物库的检索索引。
 *
 * 只收未停用的条目（停用 = 用户明说不该再用它算菜），键用 `nameNorm`；
 * 库里少了 `nameNorm` 的老条目按 `normalizeFoodName(name)` 补一个。
 */
export interface FoodIndex {
  byNorm: Map<string, Food>
}

export function buildFoodIndex(foods: readonly Food[]): FoodIndex {
  const byNorm = new Map<string, Food>()
  for (const food of foods) {
    if (food.disabledFlag === 1) continue
    const key = food.nameNorm?.trim() ? food.nameNorm : normalizeFoodName(food.name)
    if (key && !byNorm.has(key)) byNorm.set(key, food)
  }
  return { byNorm }
}

/**
 * 按名称匹配食物库。
 *
 * 三级，越往后越宽松：归一化相等 → 去掉括号限定语相等（`鸡胸肉` 对上 `鸡胸肉(生 去皮)`）→
 * 「名字互为前缀」的唯一候选。第三步必须**唯一**才认：库里同时有 `鸡蛋(全蛋 生)` 与
 * `鸡蛋(水煮)` 时，「鸡蛋」匹配谁都是猜，猜错的数值比空着更糟 —— 所以返回 `undefined`，
 * 由调用方标成「本地库里没有」。
 */
export function matchFood(index: FoodIndex, name: string): Food | undefined {
  const key = normalizeFoodName(name)
  if (!key) return undefined
  const exact = index.byNorm.get(key)
  if (exact) return exact

  const base = normalizeFoodName(baseNameOf(name))
  if (!base) return undefined
  const candidates = [...index.byNorm.entries()].filter(([, food]) => baseNameOf(normalizeFoodName(food.name)) === base)
  if (candidates.length === 1) return candidates[0][1]
  if (candidates.length > 1) return candidates.find(([norm]) => norm === base)?.[1]
  return undefined
}

export interface MealPlanRecompute {
  content: PlanMealContent
  /** 本地闸门给出的提示（库里没有的食材、模型估值与本地库不一致等） */
  notices: string[]
}

function recomputeLine(
  index: FoodIndex,
  raw: { food: string; grams: number; dish?: string },
  seasoning: boolean,
  missing: string[]
): PlanMealLine {
  const food = matchFood(index, raw.food)
  const grams = Number.isFinite(raw.grams) ? raw.grams : 0
  if (!food) {
    missing.push(raw.food)
    return { food: raw.food, grams, dish: raw.dish, seasoning: seasoning || undefined }
  }
  return {
    food: raw.food,
    grams,
    dish: raw.dish,
    seasoning: seasoning || undefined,
    foodId: food.id,
    matchedName: food.name,
    facts: factsForGrams(food, grams)
  }
}

/**
 * 把模型给的食谱按食物库复算一遍（FR-806）。
 *
 * 命中不了库的食材**不进合计**（宁少不臆造）：显示出来的那一份必须每一行都能在库里指出来源，
 * 否则「本地复算」就成了摆设。缺什么会在提示里列名，用户能去 `/foods` 补。
 */
export function recomputeMealPlan(output: PlanMealOutput, index: FoodIndex): MealPlanRecompute {
  const missing: string[] = []
  const items = (output.items ?? []).map((raw) => recomputeLine(index, raw, false, missing))
  const seasonings = (output.seasonings ?? []).map((raw) => recomputeLine(index, raw, true, missing))
  const totals = sumFacts(
    [...items, ...seasonings].map((line) => line.facts).filter((facts): facts is NutritionFacts => !!facts)
  )

  const notices: string[] = []
  const uniqueMissing = [...new Set(missing)]
  if (uniqueMissing.length) {
    notices.push(
      `本地食物库里没有 ${uniqueMissing.map((name) => `「${name}」`).join('')}，这几行没有算进合计 —— 先去「食物库」把它的数值补上（FR-806）`
    )
  }

  const preview = output.totalsPreview
  const localKcal = totals.kcal
  if (preview && Number.isFinite(preview.kcal) && localKcal > 0) {
    const ratio = Math.abs(preview.kcal - localKcal) / localKcal
    if (ratio > PREVIEW_TOLERANCE) {
      notices.push(
        `模型给出的估算与本地库不一致（模型写 ${Math.round(preview.kcal)} kcal，本地按食物库重算是 ${Math.round(localKcal)} kcal），已按本地库显示（FR-806）`
      )
    }
  }

  return {
    content: {
      title: output.title,
      items,
      seasonings,
      totals,
      missing: uniqueMissing,
      totalsPreview: preview,
      shoppingList: output.shoppingList
    },
    notices
  }
}

/** 食谱的本地合计与今天缺口的对照（FR-802，一行一项）。 */
export interface GapRow {
  key: 'kcal' | 'proteinG' | 'sodiumMg' | 'fiberG'
  label: string
  /** 这一顿按本地库算出来的量 */
  plan: number
  /** 还差多少（负数 = 已经超了） */
  remaining?: number
  /** 超过上限（钠）/ 吃够了（热量、蛋白、纤维） */
  reached?: boolean
  over?: boolean
}

export interface PlanMealGap {
  remainingKcal?: number
  remainingProteinG?: number
  sodiumMaxMg?: number
  sodiumSoFarMg?: number
  fiberTargetG?: number
  fiberSoFarG?: number
}

/** 热量留一点余量再算「超了」：按克数复算本来就有几 kcal 的零头，卡死会天天报超。 */
const KCAL_SLACK = 50

export function compareWithGap(totals: NutritionFacts, gap: PlanMealGap): GapRow[] {
  const rows: GapRow[] = []
  if (gap.remainingKcal !== undefined) {
    rows.push({
      key: 'kcal',
      label: '热量',
      plan: totals.kcal,
      remaining: gap.remainingKcal,
      reached: totals.kcal >= gap.remainingKcal,
      over: totals.kcal > gap.remainingKcal + KCAL_SLACK
    })
  }
  if (gap.remainingProteinG !== undefined) {
    rows.push({
      key: 'proteinG',
      label: '蛋白质',
      plan: totals.proteinG,
      remaining: gap.remainingProteinG,
      reached: totals.proteinG >= gap.remainingProteinG
    })
  }
  if (gap.sodiumMaxMg !== undefined) {
    const remaining = Math.round(gap.sodiumMaxMg - (gap.sodiumSoFarMg ?? 0))
    rows.push({ key: 'sodiumMg', label: '钠', plan: totals.sodiumMg, remaining, over: totals.sodiumMg > remaining })
  }
  if (gap.fiberTargetG !== undefined) {
    const remaining = gap.fiberTargetG - (gap.fiberSoFarG ?? 0)
    rows.push({ key: 'fiberG', label: '纤维', plan: totals.fiberG, remaining, reached: totals.fiberG >= remaining })
  }
  return rows
}

/** 本地复核一个动作要用到的器材够不够。 */
export function equipmentAvailable(used: string, available: readonly string[]): boolean {
  const key = used.trim().toLowerCase()
  if (!key) return true
  return available.some((item) => {
    const have = item.trim().toLowerCase()
    if (!have) return false
    // 双向包含：「哑铃」对上「一对哑铃（可调）」，「可调哑铃」对上「哑铃」都算有
    return have.includes(key) || key.includes(have)
  })
}

export interface TrainingPlanContext {
  /** 档案里的可用器材（一行一件） */
  equipment: string[]
  /** 动作名 → 最近一次的重量与写法（`recentExerciseLoads` 的产物，按名字索引） */
  lastByExercise: Map<string, { weightKg?: number; date: string; volume: string }>
  /** 肌群 → 距上次训练多少小时（`muscleRecency` 的产物） */
  hoursSinceMuscle: Map<string, number>
}

export interface DroppedExercise {
  name: string
  reason: string
}

export interface TrainingPlanReview {
  content: PlanTrainingContent
  dropped: DroppedExercise[]
  /** 计划里落在 48 小时内的肌群（恢复优先，FR-801） */
  recentMuscles: string[]
  notices: string[]
}

/**
 * 本地复核训练计划：器材白名单、加重幅度、恢复窗口、时长。
 *
 * 只**剔除**器材不满足的动作（那是「你根本没有这件器材」，做了也没法做）；
 * 加重与恢复窗口是**提示**不是拦截 —— 用户完全可以自主决定今天加多少（FR-801 要的是
 * 「给具体加重并说明」，不是替他决定）。被剔除的动作写进提示，不能静默消失。
 */
export function reviewTrainingPlan(output: PlanTrainingOutput, ctx: TrainingPlanContext): TrainingPlanReview {
  const notices: string[] = []
  const dropped: DroppedExercise[] = []
  const recentMuscles: string[] = []
  const exercises: PlanTrainingExercise[] = []

  for (const exercise of output.exercises ?? []) {
    const used = exercise.equipment ?? []
    const missing = used.filter((item) => !equipmentAvailable(item, ctx.equipment))
    if (used.length && missing.length === used.length) {
      dropped.push({ name: exercise.name, reason: `档案里的可用器材没有「${missing.join(' / ')}」` })
      continue
    }

    const reviewed: PlanTrainingExercise = { ...exercise }
    if (!used.length) {
      reviewed.equipmentNote = '没标器材，本地核不了'
    } else if (missing.length) {
      reviewed.equipmentNote = `用到的「${missing.join(' / ')}」不在档案的器材里，请确认`
    }

    const last = ctx.lastByExercise.get(normalizeFoodName(exercise.name))
    if (last?.weightKg && exercise.weightKg && exercise.weightKg > last.weightKg * (1 + WEIGHT_STEP_LIMIT)) {
      reviewed.weightNote = `比上次（${last.date} · ${last.volume}）重了 ${Math.round(
        (exercise.weightKg / last.weightKg - 1) * 100
      )}%，超过 +10%，涨之前先确认`
    }

    for (const muscle of exercise.muscles ?? []) {
      const hours = ctx.hoursSinceMuscle.get(muscle)
      if (hours !== undefined && hours < RECOVERY_HOURS && !recentMuscles.includes(muscle)) recentMuscles.push(muscle)
    }
    exercises.push(reviewed)
  }

  if (dropped.length) {
    notices.push(
      `剔除了 ${dropped.length} 个用不到器材的动作：${dropped
        .map((item) => `${item.name}（${item.reason}）`)
        .join('；')}`
    )
  }
  if (recentMuscles.length) {
    notices.push(
      `${recentMuscles.join(' / ')} 在 48 小时内练过，还没恢复 —— 恢复优先是 FR-801 的第一条，要么换肌群，要么减量`
    )
  }

  const totalSets = exercises.reduce((sum, exercise) => sum + (exercise.sets > 0 ? exercise.sets : 0), 0)
  const estimatedMinutes = totalSets > 0 ? Math.round(totalSets * MINUTES_PER_SET + WARMUP_MINUTES) : 0
  if (estimatedMinutes > 0 && output.estimatedMinutes > 0) {
    const ratio = Math.abs(output.estimatedMinutes - estimatedMinutes) / estimatedMinutes
    if (ratio > DURATION_TOLERANCE) {
      notices.push(
        `模型写的预计时长（${output.estimatedMinutes} 分钟）与本地按组数估的（${estimatedMinutes} 分钟）差得比较多，已按本地显示`
      )
    }
  }

  return {
    content: {
      focus: output.focus,
      estimatedMinutes,
      // 一个动作都不剩时按「今天别练」处理：给一条空清单比让他照着不存在的动作练强
      exercises,
      notes: output.notes ?? []
    },
    dropped,
    recentMuscles,
    notices
  }
}

