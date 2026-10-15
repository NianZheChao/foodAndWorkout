/**
 * 存储边界必须能吃下**响应式对象**（2026-10-15 记录训练报 DataCloneError 的回归）。
 *
 * Vue 的 `ref([])` / `reactive()` / `computed()` 给出来的是 Proxy，而 IndexedDB 的 structuredClone
 * 克隆不了 Proxy —— 页面把 `muscles.value` 直接传下来，`db.workout.put` 就炸了。
 * 修法是把「拍平」放在仓储写入层（`src/data/plain.ts`），所以这里逐条验证每个写入函数都扛得住。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { computed, isProxy, reactive, ref } from 'vue'
import { db } from '@/data/db'
import { addIntake, updateIntake } from '@/data/repositories/intake'
import { addWorkout, listWorkoutByDate, updateWorkout } from '@/data/repositories/workout'
import { updateDay, getDay, saveSummary } from '@/data/repositories/days'
import { saveProfile, getProfile } from '@/data/repositories/profile'
import { putDraft, getDraft } from '@/data/repositories/drafts'
import { putReport, getReport } from '@/data/repositories/reports'
import { saveModelConfig, getModelConfig } from '@/data/repositories/modelConfig'
import { saveSettings, getSettings } from '@/data/repositories/settings'
import { logLlmCall } from '@/data/repositories/llmLogs'
import { enqueue, listOpenOps, markOp } from '@/data/repositories/pendingOps'
import { putTargets, saveTargets, listCalibrations, applyCalibration } from '@/data/repositories/targets'
import { setMeta, getMeta } from '@/data/meta'
import { buildDaySummary } from '@/domain/targets'
import type { WorkoutSet } from '@/domain/types'

const DATE = '2026-10-15'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('响应式对象写入 IndexedDB', () => {
  it('记训练：muscles / sets 来自 ref / reactive 也能落库（本次报错的现场）', async () => {
    const muscles = ref<string[]>(['胸', '三头'])
    const weight = ref(16)
    const sets = computed<WorkoutSet[]>(() =>
      Array.from({ length: 3 }, () => ({ reps: 8, weightKg: weight.value, bodyweight: false }))
    )

    await addWorkout({
      date: DATE,
      type: '力量',
      exercise: '哑铃卧推',
      muscles: muscles.value,
      sets: sets.value,
      volumeRaw: '3x8x16kg',
      volumeLoad: 384
    })

    const [saved] = await listWorkoutByDate(DATE)
    expect(saved.muscles).toEqual(['胸', '三头'])
    expect(saved.sets).toHaveLength(3)
    expect(isProxy(saved.muscles)).toBe(false)
    expect(isProxy(saved.sets)).toBe(false)
  })

  it('记饮食：amount / computed 是响应式对象也照样写', async () => {
    const amount = reactive({ qty: 1, unit: '200g', grams: 200 })
    const id = await addIntake({
      date: DATE,
      meal: '午餐',
      dish: '鸡胸饭',
      foodId: '鸡胸肉(生 去皮)',
      foodSnapshot: reactive({
        name: '鸡胸肉(生 去皮)',
        unit: '100g',
        kcal: 133,
        proteinG: 19.4,
        fatG: 5,
        carbG: 2.5,
        fiberG: 0,
        sodiumMg: 34.8
      }),
      amount,
      computed: reactive({ kcal: 266, proteinG: 38.8, fatG: 10, carbG: 5, fiberG: 0, sodiumMg: 69.6 })
    })

    await updateIntake(id, { note: '响应式补丁' })
    await updateWorkout('wo_missing', reactive({ note: '响应式补丁' }))
    const row = await db.intake.get(id)
    expect(row?.amount.grams).toBe(200)
    expect(row?.note).toBe('响应式补丁')
    expect(isProxy(row?.amount)).toBe(false)
  })

  it('记身体 / 汇总：patch 与 summary 是响应式的也能写', async () => {
    await updateDay(DATE, reactive({ weightAmKg: 75.4, note: '晨重' }))
    expect((await getDay(DATE))?.weightAmKg).toBe(75.4)

    const summary = buildDaySummary({
      date: DATE,
      intake: reactive({ kcal: 1800, proteinG: 120, fatG: 60, carbG: 180, fiberG: 20, sodiumMg: 1500 }),
      targets: {
        kcalTarget: 2240,
        proteinTargetG: 150,
        fatTargetG: 60,
        carbTargetG: 275,
        fiberTargetG: 30,
        sodiumMaxMg: 2300
      },
      training: reactive({ minutes: 45, sets: 12, volumeLoadKg: 384, isRestDay: false }),
      pendingCount: 0,
      computedAt: Date.now()
    })
    await saveSummary(DATE, summary)
    expect((await getDay(DATE))?.summarySnapshot?.rows).toHaveLength(6)
  })

  it('档案 / 目标 / 校准：菜单式响应式表单也能写', async () => {
    await saveProfile(
      reactive({
        id: 'current' as const,
        sex: 'male' as const,
        age: 30,
        heightCm: 175,
        weightKg: 75,
        goal: '减脂' as const,
        trainingLevel: '新手' as const,
        dailyCookMinutes: 30,
        seasonings: reactive({ 盐: true, 蚝油: false }),
        equipment: reactive(['哑铃', '厨房秤']),
        conventions: reactive(['不记录饮水']),
        mutedFields: reactive([]),
        updatedAt: Date.now()
      })
    )
    const profile = await getProfile()
    expect(profile?.equipment).toEqual(['哑铃', '厨房秤'])
    expect(isProxy(profile?.equipment)).toBe(false)

    await putTargets({
      tdeeKcal: 2633,
      kcalTarget: 2240,
      proteinTargetG: 150,
      fatTargetG: 60,
      carbTargetG: 275,
      fiberTargetG: 30,
      sodiumMaxMg: 2300,
      weeklyTrainingDays: 3,
      weeklySetsPerMuscle: 10,
      targetWeightKg: 70,
      targetRateKgPerWeek: -0.36,
      reviewCadence: 'weekly'
    })
    await saveTargets(reactive({ kcalTarget: 2190 }))
    await applyCalibration({ date: DATE, measuredTdee: 2600, kcalAfter: 2140, basis: '响应式测试' })
    const calibrations = await listCalibrations()
    expect(calibrations[0].kcalAfter).toBe(2140)
  })

  it('草稿 / 报告：嵌套数组与对象都是响应式的也能写', async () => {
    await putDraft({
      id: 'draft_x',
      date: DATE,
      kind: 'intake',
      status: 'collecting',
      rawText: '中午吃了鸡胸饭',
      imageCount: 0,
      meal: '午餐',
      dish: '鸡胸饭',
      intake: reactive([
        reactive({ key: 'i0', dish: '鸡胸饭', food: '鸡胸肉', amountText: '200g', grams: 200, pending: false, confidence: 'high' as const })
      ]),
      workout: reactive({ type: '力量' as const, exercises: [] }),
      questions: reactive([]),
      assumptions: reactive([]),
      uncertain: reactive([]),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    const draft = await getDraft('draft_x')
    expect(draft?.intake[0].grams).toBe(200)
    expect(isProxy(draft?.intake)).toBe(false)

    await putReport(
      reactive({
        id: 'rep_x',
        type: 'weekly' as const,
        label: '2026-W42',
        periodStart: '2026-10-12',
        periodEnd: DATE,
        digest: reactive({
          period: reactive({ type: 'weekly' as const, label: '2026-W42', start: '2026-10-12', end: DATE, days: 4 }),
          coverage: reactive({ daysWithIntake: 2, daysWithWeight: 2, ratio: 0.5 }),
          intake: {
            avgKcal: 1800,
            target: 2240,
            avgProteinG: 120,
            proteinTargetG: 150,
            kcalHitDays: 0,
            proteinHitDays: 0,
            recordedDays: 2
          },
          weight: reactive({ amSeries: reactive([{ date: DATE, kg: 75.1 }]) }),
          training: {
            days: 1,
            minutes: 45,
            sets: 12,
            volumeLoadKg: 384,
            byMuscle: reactive([{ muscle: '胸', sets: 3 }]),
            targetDays: 3,
            targetSetsPerMuscle: 10
          },
          currentTargets: { kcalTarget: 2240, proteinTargetG: 150 }
        }),
        content: null,
        status: 'pending' as const,
        flaggedNumbers: reactive(['380']),
        editedByUser: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    )
    const report = await getReport('rep_x')
    expect(report?.digest.training.byMuscle).toEqual([{ muscle: '胸', sets: 3 }])
    expect(report?.flaggedNumbers).toEqual(['380'])
  })

  it('设置 / 模型配置 / 调用日志 / 队列 / meta：单例与补丁都扛得住响应式', async () => {
    await saveModelConfig(reactive({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat' }))
    expect((await getModelConfig()).model).toBe('deepseek-chat')

    await saveSettings(reactive({ mutedFields: reactive(['油.grams']) }))
    expect((await getSettings()).mutedFields).toEqual(['油.grams'])

    await logLlmCall({ taskId: 'food.resolve', taskVersion: 1, model: 'deepseek-chat', durationMs: 12, promptTokensEst: 10, completionTokensEst: 5, status: 'ok' })
    expect((await db.llmLogs.toArray())[0].model).toBe('deepseek-chat')

    const opId = await enqueue('food.resolve', '凯撒沙拉')
    await markOp(opId, reactive({ lastError: '网络失败' }))
    expect((await listOpenOps())[0].lastError).toBe('网络失败')

    await setMeta('seedVersion', reactive({ build: 'test' }))
    expect(await getMeta('seedVersion')).toEqual({ build: 'test' })
  })
})
