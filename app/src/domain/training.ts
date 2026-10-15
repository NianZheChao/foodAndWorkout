/**
 * 训练计算：组次重量解析、容量负荷、MET 消耗、肌群组数。
 *
 * 口径与 `scripts/nutrition.py` 的 `set_load` / `load_day` 训练部分一致：
 * - 容量负荷 = 组 × 次 × 重量，自重动作计 0（DR-21）
 * - 有氧消耗 = MET × 3.5 × 体重(kg) / 200 × 时长(min)
 * - 一行记录若组次格式无法解析，按 1 组计（与脚本一致，避免整行丢失）
 */

import type { WorkoutEntry, WorkoutSet } from '@/domain/types'

/** 与脚本一致：`4x10x60`、`3х12х自重`、`4×8×57.5` 都要能认。 */
const SETS_RE = /^(\d+)\s*[xх×*]\s*(\d+)\s*[xх×*]\s*([\d.]+|自重|徒手)/
const BODYWEIGHT_MARKS = ['自重', '徒手']
/** 肌群分隔符，与脚本一致。 */
const MUSCLE_SPLIT_RE = /[、,，/＋+]/

export interface ParsedSetVolume {
  sets: number
  reps: number
  /** 自重 / 徒手时为 undefined */
  weightKg?: number
  /** 自重 / 徒手时为 undefined（脚本用 None 表示「不计容量」） */
  volumeLoad?: number
}

/** 解析「组x次x重量」。无法解析返回 undefined。 */
export function parseSetVolume(raw: string | undefined): ParsedSetVolume | undefined {
  if (!raw) return undefined
  const match = SETS_RE.exec(raw.trim())
  if (!match) return undefined
  const sets = Number(match[1])
  const reps = Number(match[2])
  const token = match[3]
  if (BODYWEIGHT_MARKS.includes(token)) return { sets, reps }
  const weightKg = Number(token)
  if (!Number.isFinite(weightKg)) return { sets, reps }
  return { sets, reps, weightKg, volumeLoad: sets * reps * weightKg }
}

export function isBodyweightSet(set: WorkoutSet): boolean {
  return set.bodyweight || !set.weightKg
}

/** 单个动作组次结构的容量负荷；自重记 0。 */
export function setVolumeLoad(set: WorkoutSet): number {
  if (isBodyweightSet(set)) return 0
  return set.reps * (set.weightKg as number)
}

export function volumeLoadOf(sets: readonly WorkoutSet[] | undefined): number {
  if (!sets?.length) return 0
  return sets.reduce((sum, set) => sum + setVolumeLoad(set), 0)
}

/**
 * 有氧 / 球类的热量估算。
 *
 * @param met      活动当量，来自动作表
 * @param weightKg 体重，取当日晨重，缺失时取最近有效晨重（由调用方解析）
 * @param minutes  时长（分钟）
 */
export function metKcal(met: number, weightKg: number, minutes: number): number {
  return ((met * 3.5 * weightKg) / 200) * minutes
}

/** 常用 MET 参考值（供模型输出与用户选择时兜底）。 */
export const MET_TABLE: Record<string, number> = {
  走路: 3.5,
  慢跑: 7,
  跑步: 9.8,
  骑行: 7.5,
  游泳: 8,
  划船机: 7,
  跳绳: 11,
  椭圆机: 5,
  爬楼: 8.8,
  篮球: 6.5,
  足球: 7,
  羽毛球: 5.5,
  乒乓球: 4,
  拉伸: 2.3
}

export interface MoveAggregate {
  sets: number
  load: number
  /** 最近一次出现的组次写法，如 `4x10x60` */
  volume: string
  muscles: string
  dates: string[]
}

export interface TrainingAggregate {
  /** 动作条目数（脚本按「行」计） */
  rows: number
  minutes: number
  burn: number
  sets: number
  load: number
  loadedSets: number
  bodyweightSets: number
  rpe: number[]
  /** 肌群 → 组数 */
  muscles: Record<string, number>
  /** 肌群 → 容量负荷（自重不计） */
  muscleLoad: Record<string, number>
  /** 动作 → 明细（用于渐进超负荷对比） */
  moves: Record<string, MoveAggregate>
}

export function emptyAggregate(): TrainingAggregate {
  return {
    rows: 0,
    minutes: 0,
    burn: 0,
    sets: 0,
    load: 0,
    loadedSets: 0,
    bodyweightSets: 0,
    rpe: [],
    muscles: {},
    muscleLoad: {},
    moves: {}
  }
}

export function splitMuscles(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(MUSCLE_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** 单条训练记录折算成「组数 / 容量」；组次结构缺失时按 1 组计。 */
export function entrySetsAndLoad(entry: WorkoutEntry): { sets: number; load: number } {
  const sets = entry.sets?.length ?? 1
  const load = entry.volumeLoad ?? volumeLoadOf(entry.sets)
  return { sets, load }
}

/**
 * 区间训练聚合。与脚本 `load_day` 的训练统计逐项对齐，
 * 供 `trend` 的训练小结与报告摘要使用。
 */
export function aggregateWorkouts(entries: readonly WorkoutEntry[]): TrainingAggregate {
  const result = emptyAggregate()
  for (const entry of entries) {
    result.rows += 1
    if (entry.rpe) result.rpe.push(entry.rpe)
    if (entry.minutes) result.minutes += entry.minutes
    if (entry.estimatedKcal) result.burn += entry.estimatedKcal

    const { sets, load } = entrySetsAndLoad(entry)
    result.sets += sets
    if (load) {
      result.load += load
      result.loadedSets += sets
    } else {
      result.bodyweightSets += sets
    }

    const muscles = entry.muscles ?? []
    for (const muscle of muscles) {
      result.muscles[muscle] = (result.muscles[muscle] ?? 0) + sets
      if (load) result.muscleLoad[muscle] = (result.muscleLoad[muscle] ?? 0) + load
    }

    const move = entry.exercise?.trim()
    if (move) {
      const bucket = result.moves[move] ?? { sets: 0, load: 0, volume: '', muscles: '', dates: [] }
      bucket.sets += sets
      bucket.load += load
      bucket.volume = entry.volumeRaw?.trim() || bucket.volume
      bucket.muscles = muscles.join('/') || bucket.muscles
      if (!bucket.dates.includes(entry.date)) bucket.dates.push(entry.date)
      result.moves[move] = bucket
    }
  }
  return result
}

/** 按容量降序、同名按字典序（与脚本 `training_detail` 的排序一致）。 */
export function rankMoves(moves: Record<string, MoveAggregate>): [string, MoveAggregate][] {
  return Object.entries(moves).sort((a, b) => b[1].load - a[1].load || (a[0] < b[0] ? -1 : 1))
}

const MUSCLE_KEYWORDS: readonly [RegExp, string][] = [
  [/卧推|飞鸟|夹胸|俯卧撑|推胸|胸推/, '胸'],
  [/划船|引体|下拉|硬拉|高拉|背部/, '背'],
  [/推举|肩推|侧平举|面拉|耸肩|前平举/, '肩'],
  [/二头|弯举/, '二头'],
  [/三头|臂屈伸|下压/, '三头'],
  [/臀桥|臀冲|髋外展|髋推|臀部/, '臀'],
  [/深蹲|腿举|腿屈伸|腿弯举|弓步|小腿|箭步|腿部/, '腿'],
  [/卷腹|平板支撑|核心|仰卧起坐|举腿|死虫/, '核心']
]

/**
 * 从动作名推断目标肌群。
 *
 * `log.parse` 的契约里没有肌群字段（§6.11），但 `WorkoutEntry.muscles` 是必备的
 * （每肌群组数是周报与推荐的核心指标），所以在本地补齐；推断不出来就返回空数组——
 * 与「不臆造」一致，宁可缺也不乱填。
 */
export function inferMusclesFromExercise(exercise: string): string[] {
  if (!exercise) return []
  const hits = MUSCLE_KEYWORDS.filter(([pattern]) => pattern.test(exercise)).map(([, muscle]) => muscle)
  return [...new Set(hits)]
}
