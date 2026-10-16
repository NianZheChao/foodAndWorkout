// @vitest-environment node
/**
 * 推荐（B 级，T3.8）的本地加工：`domain/plan.ts` 与 `domain/training.ts` 里新增的两段聚合。
 *
 * 守五条：食材按食物库重算（命中不了就不进合计）、模型自报偏差能识别、器材白名单真的剔除、
 * 加重超过 +10% 会提示、时长按组数本地算。这些都是「确定性计算一律本地算」的具体形状。
 */

import { describe, expect, it } from 'vitest'
import {
  buildFoodIndex,
  compareWithGap,
  DURATION_TOLERANCE,
  equipmentAvailable,
  matchFood,
  MINUTES_PER_SET,
  PREVIEW_TOLERANCE,
  RECOVERY_HOURS,
  recomputeMealPlan,
  reviewTrainingPlan,
  WARMUP_MINUTES,
  type PlanMealOutput,
  type PlanTrainingOutput
} from '@/domain/plan'
import { normalizeFoodName } from '@/domain/foodName'
import { muscleRecency, recentExerciseLoads } from '@/domain/training'
import type { Food, WorkoutEntry } from '@/domain/types'

function food(patch: Partial<Food> & { name: string }): Food {
  return {
    id: patch.name,
    nameNorm: normalizeFoodName(patch.name),
    category: '测试',
    unit: '100g',
    kcal: 100,
    proteinG: 10,
    fatG: 5,
    carbG: 5,
    fiberG: 1,
    sodiumMg: 100,
    source: 'seed',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

const LIBRARY: Food[] = [
  food({ name: '鸡胸肉(生 去皮)', kcal: 133, proteinG: 19.4, fatG: 5, carbG: 2.5, sodiumMg: 34.8 }),
  food({ name: '食用油', kcal: 899, proteinG: 0, fatG: 99.9, carbG: 0, fiberG: 0, sodiumMg: 0 }),
  food({ name: '西兰花', kcal: 36, proteinG: 4.1, fatG: 0.6, carbG: 4.3, fiberG: 2.6, sodiumMg: 18 }),
  food({ name: '鸡蛋(全蛋 生)', kcal: 144, proteinG: 13.3 }),
  food({ name: '鸡蛋(水煮)', kcal: 155, proteinG: 12.6 }),
  food({ name: '下架的米', kcal: 350, proteinG: 7, disabledFlag: 1 })
]

const index = buildFoodIndex(LIBRARY)

describe('食物库匹配（FR-806 的第一步）', () => {
  it('归一化相等与去括号匹配都能命中', () => {
    expect(matchFood(index, '鸡胸肉(生去皮)')?.name).toBe('鸡胸肉(生 去皮)')
    expect(matchFood(index, '鸡胸肉')?.name).toBe('鸡胸肉(生 去皮)')
    expect(matchFood(index, '西兰花')?.name).toBe('西兰花')
  })

  it('多个候选时宁可不认，也不猜', () => {
    // 库里同时有「鸡蛋(全蛋 生)」与「鸡蛋(水煮)」：猜错的数值比空着更糟
    expect(matchFood(index, '鸡蛋')).toBeUndefined()
    expect(matchFood(index, '鸡蛋(水煮)')?.name).toBe('鸡蛋(水煮)')
  })

  it('停用的条目不当成候选', () => {
    expect(matchFood(index, '下架的米')).toBeUndefined()
  })
})

describe('食谱本地复算（FR-806）', () => {
  const output: PlanMealOutput = {
    title: '鸡胸西兰花',
    items: [
      { food: '鸡胸肉', grams: 200, dish: '香煎' },
      { food: '西兰花', grams: 150 }
    ],
    seasonings: [{ food: '食用油', grams: 8 }],
    totalsPreview: { kcal: 400, proteinG: 0, fatG: 0, carbG: 0 },
    shoppingList: [{ item: '鸡胸肉', amount: '500g', substitute: '鸡腿肉去皮' }]
  }

  it('逐行按食物库算，合计是本地加出来的', () => {
    const { content } = recomputeMealPlan(output, index)
    expect(content.items[0].facts?.kcal).toBeCloseTo(266, 5)
    expect(content.items[0].facts?.proteinG).toBeCloseTo(38.8, 5)
    expect(content.items[0].foodId).toBe('鸡胸肉(生 去皮)')
    expect(content.seasonings[0].seasoning).toBe(true)
    // 266 + 54 + 71.92 = 391.92
    expect(content.totals.kcal).toBeCloseTo(391.92, 5)
    expect(content.missing).toEqual([])
  })

  it('库里没有的食材不进合计，但要列名提示', () => {
    const { content, notices } = recomputeMealPlan(
      { title: 'x', items: [{ food: '不存在的食材', grams: 100 }] },
      index
    )
    expect(content.totals.kcal).toBe(0)
    expect(content.items[0].facts).toBeUndefined()
    expect(content.missing).toEqual(['不存在的食材'])
    expect(notices[0]).toContain('不存在的食材')
  })

  it('模型自报的合计与本地重算差得太多就提示（超过 15%）', () => {
    const close = recomputeMealPlan({ ...output, totalsPreview: { kcal: 400, proteinG: 0, fatG: 0, carbG: 0 } }, index)
    expect(close.notices.some((note) => note.includes('不一致'))).toBe(false)

    const far = recomputeMealPlan({ ...output, totalsPreview: { kcal: 200, proteinG: 0, fatG: 0, carbG: 0 } }, index)
    expect(far.notices.some((note) => note.includes('已按本地库显示'))).toBe(true)
    // 展示用的还是本地那一份
    expect(far.content.totals.kcal).toBeCloseTo(391.92, 5)
    expect(far.content.totalsPreview?.kcal).toBe(200)
    expect(PREVIEW_TOLERANCE).toBe(0.15)
  })
})

describe('与缺口的对比（FR-802，本地减法）', () => {
  it('热量超了标出来、蛋白够了标出来、钠有自己的余量', () => {
    const rows = compareWithGap(
      { kcal: 700, proteinG: 40, fatG: 20, carbG: 60, fiberG: 5, sodiumMg: 900 },
      { remainingKcal: 600, remainingProteinG: 30, sodiumMaxMg: 2000, sodiumSoFarMg: 1500, fiberTargetG: 30, fiberSoFarG: 20 }
    )
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]))
    expect(byKey.kcal.over).toBe(true)
    expect(byKey.proteinG.reached).toBe(true)
    expect(byKey.sodiumMg.remaining).toBe(500)
    expect(byKey.sodiumMg.over).toBe(true)
    expect(byKey.fiberG.reached).toBe(false)
  })

  it('没设目标的项目不出现在对照表里', () => {
    expect(compareWithGap({ kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 }, {})).toEqual([])
  })
})

describe('训练计划的本地复核（§6.5 的本地处理）', () => {
  const output: PlanTrainingOutput = {
    focus: '腿',
    estimatedMinutes: 45,
    exercises: [
      { name: '杠铃深蹲', muscles: ['腿'], sets: 4, reps: 8, weightKg: 60, equipment: ['杠铃'], reason: '腿部欠账最多' },
      { name: '哑铃卧推', muscles: ['胸'], sets: 3, reps: 10, weightKg: 20, equipment: ['哑铃'], reason: '胸欠账' },
      { name: '引体向上', muscles: ['背'], sets: 3, reps: 8, reason: '背部欠账' }
    ],
    notes: ['组间休息 90 秒']
  }

  const ctx = {
    equipment: ['哑铃', '健身房（有杠铃）'],
    lastByExercise: new Map([['哑铃卧推', { weightKg: 25, date: '2026-10-12', volume: '3x10x25' }]]),
    hoursSinceMuscle: new Map([['腿', 24]])
  }

  it('器材核不上就剔除，并写清原因；没标器材的留着但注明核不了', () => {
    const review = reviewTrainingPlan(output, { ...ctx, equipment: ['自重'] })
    expect(review.content.exercises.map((item) => item.name)).toEqual(['引体向上'])
    expect(review.dropped.map((item) => item.name)).toEqual(['杠铃深蹲', '哑铃卧推'])
    expect(review.notices[0]).toContain('剔除')
    expect(review.content.exercises[0].equipmentNote).toContain('没标器材')
  })

  it('器材命中用包含关系（「健身房（有杠铃）」算有杠铃）', () => {
    expect(equipmentAvailable('杠铃', ctx.equipment)).toBe(true)
    expect(equipmentAvailable('杠铃', ['自重'])).toBe(false)
    const review = reviewTrainingPlan(output, ctx)
    expect(review.dropped).toEqual([])
    expect(review.content.exercises[0].equipmentNote).toBeUndefined()
  })

  it('加重超过上次 +10% 会提示，不拦', () => {
    const review = reviewTrainingPlan(output, ctx)
    const bench = review.content.exercises.find((item) => item.name === '哑铃卧推')
    // 20 < 25，不算激进加重
    expect(bench?.weightNote).toBeUndefined()

    const heavy = reviewTrainingPlan(
      { ...output, exercises: [{ ...output.exercises[1], weightKg: 30 }] },
      ctx
    )
    expect(heavy.content.exercises[0].weightNote).toContain('超过 +10%')
  })

  it('48 小时内练过的肌群进提示（恢复优先）', () => {
    const review = reviewTrainingPlan(output, ctx)
    expect(review.recentMuscles).toEqual(['腿'])
    expect(review.notices.some((note) => note.includes('还没恢复'))).toBe(true)
    expect(RECOVERY_HOURS).toBe(48)
  })

  it('时长由本地按组数算，与模型差得多时提示', () => {
    const review = reviewTrainingPlan(output, ctx)
    // 10 组 × 3 分钟 + 8 分钟热身 = 38；模型写 45（差 18%）在容差内，不啰嗦
    expect(review.content.estimatedMinutes).toBe(10 * MINUTES_PER_SET + WARMUP_MINUTES)
    expect(review.notices.some((note) => note.includes('预计时长'))).toBe(false)

    const far = reviewTrainingPlan({ ...output, estimatedMinutes: 90 }, ctx)
    expect(far.content.estimatedMinutes).toBe(38)
    expect(far.notices.some((note) => note.includes('预计时长'))).toBe(true)
    expect(DURATION_TOLERANCE).toBe(0.25)
  })
})

describe('训练记录的本地聚合（推荐输入）', () => {
  /** `sets` 与真机一致：4x8x60 会展开成 4 条 set（`LogWorkoutPage` 的写法）。 */
  const expanded = (reps: number, weightKg: number, count: number) =>
    Array.from({ length: count }, () => ({ reps, weightKg, bodyweight: false }))

  const entries: WorkoutEntry[] = [
    { id: 'a', date: '2026-10-14', type: '力量', exercise: '杠铃深蹲', muscles: ['腿'], sets: expanded(8, 60, 4), volumeRaw: '4x8x60' },
    { id: 'b', date: '2026-10-15', type: '拉伸', exercise: '拉伸', muscles: ['腿'], minutes: 10 },
    { id: 'c', date: '2026-10-13', type: '力量', exercise: '杠铃深蹲', muscles: ['腿'], sets: expanded(6, 55, 3), volumeRaw: '3x6x55' },
    { id: 'd', date: '2026-10-15', type: '力量', exercise: '哑铃卧推', muscles: ['胸'], sets: expanded(10, 20, 1) }
  ]

  it('肌群账：组数、距上次多少小时；拉伸不算', () => {
    const rows = muscleRecency(entries, '2026-10-15')
    const byMuscle = Object.fromEntries(rows.map((row) => [row.muscle, row]))
    expect(byMuscle['腿'].sets).toBe(7)
    expect(byMuscle['腿'].hoursSinceLast).toBe(24)
    expect(byMuscle['胸'].sets).toBe(1)
    expect(byMuscle['胸'].hoursSinceLast).toBe(0)
    // 按组数降序
    expect(rows[0].muscle).toBe('腿')
  })

  it('每个动作只留最近一次，且没有 volumeRaw 时能拼出来', () => {
    const rows = recentExerciseLoads(entries)
    const squat = rows.find((row) => row.exercise === '杠铃深蹲')
    expect(squat?.date).toBe('2026-10-14')
    expect(squat?.volume).toBe('4x8x60')
    expect(squat?.weightKg).toBe(60)
    const bench = rows.find((row) => row.exercise === '哑铃卧推')
    expect(bench?.volume).toBe('1x10x20')
  })
})