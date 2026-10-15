import { beforeEach, describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { db as appDb, SCHEMA_VERSION, ThinMusclePlanDb } from '@/data/db'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import { countFoods, findByNormalizedName, seedFoods, upsertFood } from '@/data/repositories/foods'
import { ensureDay, getDay, saveSummary } from '@/data/repositories/days'
import { addIntake, countPendingIntake, listIntakeByDate } from '@/data/repositories/intake'
import { getSettings, saveSettings } from '@/data/repositories/settings'
import { applyCalibration, getTargets, putTargets } from '@/data/repositories/targets'
import { enqueue, countOpenOps, listOpenOps, markOp } from '@/data/repositories/pendingOps'
import type { DaySummary } from '@/domain/types'

/**
 * 仓储层使用应用单例连接（@/data/db 的 db），因此这里直接在单例上断言，
 * 每个用例前清空所有表，避免用例之间互相污染。
 */
beforeEach(async () => {
  await appDb.open()
  await Promise.all(appDb.tables.map((table) => table.clear()))
})

describe('schema', () => {
  it('建立全部对象存储，且版本号与设计文档一致', async () => {
    const probe = new ThinMusclePlanDb('schema-probe')
    await probe.open()
    expect(probe.verno).toBe(SCHEMA_VERSION)
    const names = probe.tables.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'calibrations',
        'days',
        'drafts',
        'foods',
        'intake',
        'llmLogs',
        'meta',
        'modelConfig',
        'pendingOps',
        'profile',
        'reports',
        'settings',
        'snapshots',
        'targets',
        'workout'
      ].sort()
    )
    probe.close()
  })

  it('v1 → v2 只新增 drafts，既有数据原样保留', async () => {
    const name = 'migration-probe'
    const legacy = new Dexie(name)
    legacy.version(1).stores({
      days: 'date',
      intake: 'id, date, meal, foodId, pendingFlag',
      foods: 'id, name, nameNorm, category, source, disabledFlag'
    })
    await legacy.open()
    await legacy.table('days').put({ date: '2026-10-01', weekday: '三', pendingCount: 0, createdAt: 1, updatedAt: 1 })
    legacy.close()

    const upgraded = new ThinMusclePlanDb(name)
    await upgraded.open()
    expect(upgraded.verno).toBe(2)
    expect(await upgraded.days.get('2026-10-01')).toMatchObject({ date: '2026-10-01', weekday: '三' })
    expect(upgraded.tables.map((table) => table.name)).toContain('drafts')
    upgraded.close()
  })

  it('布尔语义的可索引字段用 0/1（IndexedDB 不接受布尔值作键）', async () => {
    const probe = new ThinMusclePlanDb('index-probe')
    await probe.open()
    const intakeIdx = probe.intake.schema.indexes.map((i) => i.keyPath)
    expect(intakeIdx).toContain('pendingFlag')
    expect(intakeIdx).not.toContain('pending')
    const foodIdx = probe.foods.schema.indexes.map((i) => i.keyPath)
    expect(foodIdx).toContain('disabledFlag')
    expect(foodIdx).not.toContain('disabled')
    probe.close()
  })
})

describe('种子食物库', () => {
  it('首次写入全部条目，重复写入既不新增也不覆盖', async () => {
    const first = await seedFoods(foodSeed, FOOD_SEED_VERSION)
    expect(first.inserted).toBe(foodSeed.length)
    expect(await countFoods()).toBe(foodSeed.length)

    const second = await seedFoods(foodSeed, FOOD_SEED_VERSION)
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(foodSeed.length)
    expect(await countFoods()).toBe(foodSeed.length)
  })

  it('名称区分度依赖括号：鸡蛋(全蛋 生) 与 鸡蛋(水煮) 是两条不同记录', async () => {
    await seedFoods(foodSeed, FOOD_SEED_VERSION)
    const raw = await findByNormalizedName('鸡蛋(全蛋 生)')
    const boiled = await findByNormalizedName('鸡蛋(水煮)')
    expect(raw).toBeDefined()
    expect(boiled).toBeDefined()
    expect(raw?.id).not.toBe(boiled?.id)
  })

  it('按件计量的条目保留基准与数值依据', async () => {
    await seedFoods(foodSeed, FOOD_SEED_VERSION)
    const croissant = await findByNormalizedName('黄油羊角可颂')
    expect(croissant?.unit).toBe('个')
    expect(croissant?.edibleNote).toContain('每个')
  })

  it('upsert 同名条目时更新而不新增，并保留用户来源标注', async () => {
    await seedFoods(foodSeed, FOOD_SEED_VERSION)
    const before = await countFoods()
    await upsertFood({
      name: '鸡胸肉(生 去皮)',
      category: '肉禽',
      unit: '100g',
      kcal: 120,
      proteinG: 22,
      fatG: 3,
      carbG: 1,
      fiberG: 0,
      sodiumMg: 40,
      source: 'manual',
      sourceNote: '用户实测'
    })
    expect(await countFoods()).toBe(before)
    const updated = await findByNormalizedName('鸡胸肉(生 去皮)')
    expect(updated?.kcal).toBe(120)
    expect(updated?.sourceNote).toBe('用户实测')
  })
})

describe('每日记录', () => {
  it('ensureDay 幂等，不覆盖已有内容', async () => {
    const day = await ensureDay('2026-10-15')
    expect(day.weekday).toBe('四')
    await saveSummary('2026-10-15', {
      date: '2026-10-15',
      rows: [],
      training: { minutes: 0, sets: 0, volumeLoadKg: 0, isRestDay: true },
      incomplete: false,
      pendingCount: 0,
      hints: [],
      computedAt: 1
    } satisfies DaySummary)
    const again = await ensureDay('2026-10-15')
    expect(again.summarySnapshot?.computedAt).toBe(1)
    expect((await getDay('2026-10-15'))?.date).toBe('2026-10-15')
  })

  it('待补全条目单独计数（汇总据此标注不完整）', async () => {
    await addIntake({
      date: '2026-10-15',
      meal: '午餐',
      dish: '西红柿鸡蛋拌面',
      foodId: '鸡蛋(全蛋 生)',
      foodSnapshot: { name: '鸡蛋(全蛋 生)', unit: '100g', kcal: 144, proteinG: 13.3, fatG: 8.8, carbG: 2.8, fiberG: 0, sodiumMg: 131 },
      amount: { qty: 250, unit: 'g', grams: 250 },
      computed: { kcal: 360, proteinG: 33.25, fatG: 22, carbG: 7, fiberG: 0, sodiumMg: 327.5 }
    })
    await addIntake({
      date: '2026-10-15',
      meal: '午餐',
      dish: '西红柿鸡蛋拌面',
      foodId: '食用油',
      foodSnapshot: { name: '食用油', unit: '100g', kcal: 899, proteinG: 0, fatG: 99.9, carbG: 0, fiberG: 0, sodiumMg: 0 },
      amount: { qty: 0, unit: 'g' },
      computed: { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 },
      pendingFlag: 1
    })
    expect(await listIntakeByDate('2026-10-15')).toHaveLength(2)
    expect(await countPendingIntake('2026-10-15')).toBe(1)
  })
})

describe('设置与目标', () => {
  it('首次读取设置时写入默认值，并支持局部更新', async () => {
    const defaults = await getSettings()
    expect(defaults.weekStart).toBe(1)
    expect(defaults.mutedFields).toEqual([])
    const next = await saveSettings({ mutedFields: ['盐'] })
    expect(next.mutedFields).toEqual(['盐'])
    expect((await getSettings()).mutedFields).toEqual(['盐'])
  })

  it('校准同时写入校准记录与目标值（DR-32）', async () => {
    await putTargets({
      tdeeKcal: 2633,
      kcalTarget: 2100,
      proteinTargetG: 140,
      fatTargetG: 70,
      carbTargetG: 270,
      fiberTargetG: 30,
      sodiumMaxMg: 2000,
      weeklyTrainingDays: 3,
      weeklySetsPerMuscle: 10,
      targetWeightKg: 65,
      targetRateKgPerWeek: -0.39,
      reviewCadence: 'weekly'
    })
    await applyCalibration({ date: '2026-11-01', measuredTdee: 2500, kcalAfter: 2000, basis: '14 天反推' })

    const targets = await getTargets()
    expect(targets?.kcalTarget).toBe(2000)
    expect(targets?.lastCalibrated).toBe('2026-11-01')
    const rows = await appDb.calibrations.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kcalBefore: 2100, kcalAfter: 2000, measuredTdee: 2500 })
  })

  it('未初始化目标时禁止局部更新（必须先跑首次引导）', async () => {
    await expect(saveSettings({} as never)).resolves.toBeDefined()
    const { saveTargets } = await import('@/data/repositories/targets')
    await expect(saveTargets({ kcalTarget: 2000 })).rejects.toThrow('尚未初始化目标值')
  })
})

describe('待办队列', () => {
  it('入队后计入未完成数，标记完成后移出', async () => {
    const id = await enqueue('food.resolve', '2026-10-15')
    expect(await countOpenOps()).toBe(1)
    await markOp(id, { status: 'done' })
    expect(await countOpenOps()).toBe(0)
    expect(await listOpenOps()).toHaveLength(0)
  })
})
