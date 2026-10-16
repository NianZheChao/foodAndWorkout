// @vitest-environment node
/**
 * 导入（T4.1 / §7.4，FR-1205 / FR-1207）。
 *
 * 守六件事：**校验失败整包拒绝**（乱 JSON / 别的应用 / 更新的版本 / 校验和不符）、
 * **三种冲突策略各按自己说的做**、食物库按 `nameNorm` 去重且保留本地、
 * **单例逐字段合并**（不冲掉本机设置）、**导入后重算汇总**、往返一致。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { db, SCHEMA_VERSION } from '@/data/db'
import {
  applyImport,
  parseExportPackage,
  previewImport,
  type ConflictStrategy
} from '@/io/importPackage'
import {
  buildExportPackage,
  checksumOf,
  EXPORT_APP,
  serializeExport,
  type ExportData,
  type ExportPackage
} from '@/io/exportPackage'
import { APP_VERSION } from '@/app/version'
import { getDay } from '@/data/repositories/days'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listWorkoutByDate } from '@/data/repositories/workout'
import { getTargets, putTargets } from '@/data/repositories/targets'
import { saveSettings } from '@/data/repositories/settings'
import type { DayRecord, Food, IntakeEntry, SettingsRecord, WorkoutEntry } from '@/domain/types'

const DATE = '2026-10-15'

function day(date: string, patch: Partial<DayRecord> = {}): DayRecord {
  return { date, weekday: '四', pendingCount: 0, createdAt: 1, updatedAt: 1, ...patch }
}

function intake(id: string, date: string, patch: Partial<IntakeEntry> = {}): IntakeEntry {
  return {
    id,
    date,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: { name: '测试食材', unit: '100g', kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
    ...patch
  }
}

function workout(id: string, date: string, patch: Partial<WorkoutEntry> = {}): WorkoutEntry {
  return { id, date, type: '力量', muscles: ['背'], exercise: '杠铃划船', ...patch }
}

function food(nameNorm: string, patch: Partial<Food> = {}): Food {
  return {
    id: nameNorm,
    name: nameNorm,
    nameNorm,
    category: '其他',
    unit: '100g',
    kcal: 100,
    proteinG: 10,
    fatG: 3,
    carbG: 10,
    fiberG: 1,
    sodiumMg: 50,
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

async function makePackage(
  data: Partial<ExportData> = {},
  manifestPatch: Partial<ExportPackage['manifest']> = {}
): Promise<ExportPackage> {
  const full: ExportData = {
    days: [],
    intake: [],
    workout: [],
    foods: [],
    reports: [],
    calibrations: [],
    snapshots: [],
    pendingOps: [],
    drafts: [],
    adviceLog: [],
    ...data
  }
  return {
    manifest: {
      app: EXPORT_APP,
      formatVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: '2026-10-16T01:00:00.000Z',
      appVersion: APP_VERSION,
      counts: { days: full.days.length, intake: full.intake.length },
      ...manifestPatch
    },
    data: full,
    checksum: await checksumOf(full)
  }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('校验（校验失败整包拒绝）', () => {
  it('不是 JSON / 不是本应用的文件 / 没有 manifest', async () => {
    expect((await parseExportPackage('不是 json')).ok).toBe(false)
    expect((await parseExportPackage('[]')).ok).toBe(false)
    expect((await parseExportPackage(JSON.stringify({ manifest: { app: '别的应用' }, data: {}, checksum: '' }))).ok).toBe(false)
    expect((await parseExportPackage(JSON.stringify({ data: {} }))).ok).toBe(false)
  })

  it('格式版本 / 数据库版本比本应用新 → 拒绝并说清要升级', async () => {
    const newerFormat = await parseExportPackage(
      JSON.stringify(await makePackage({}, { formatVersion: 99 }))
    )
    expect(newerFormat.ok).toBe(false)
    if (!newerFormat.ok) expect(newerFormat.error).toContain('升级应用')

    const newerSchema = await parseExportPackage(JSON.stringify(await makePackage({}, { schemaVersion: 99 })))
    expect(newerSchema.ok).toBe(false)
    if (!newerSchema.ok) expect(newerSchema.error).toContain('数据库版本')
  })

  it('校验和不符 → 拒绝（文件被改动或损坏）', async () => {
    const pkg = await makePackage({ days: [day(DATE)] })
    const tampered: ExportPackage = { ...pkg, data: { ...pkg.data, days: [day(DATE, { weightAmKg: 99 })] } }
    const result = await parseExportPackage(JSON.stringify(tampered))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('校验和')
  })

  it('缺的块补成空数组（老包没有 drafts / adviceLog 也能导入）', async () => {
    const pkg = await makePackage({ days: [day(DATE)] })
    const legacy = { manifest: pkg.manifest, data: { days: pkg.data.days, intake: [], workout: [] }, checksum: '' }
    legacy.checksum = await checksumOf(legacy.data)
    const result = await parseExportPackage(JSON.stringify(legacy))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.pkg.data.drafts).toEqual([])
  })
})

describe('预览差异', () => {
  it('分得清「新增日期」与「冲突日期」，并统计食物重名', async () => {
    await db.days.put(day(DATE))
    await db.foods.put(food('测试食材'))
    const pkg = await makePackage({
      days: [day(DATE), day('2026-10-14')],
      intake: [intake('in_1', DATE)],
      foods: [food('测试食材'), food('新食物')]
    })

    const preview = await previewImport(pkg)
    expect(preview.conflictDates).toEqual([DATE])
    expect(preview.newDates).toEqual(['2026-10-14'])
    expect(preview.newFoods).toBe(1)
    expect(preview.duplicateFoods).toBe(1)
  })
})

describe('冲突策略', () => {
  async function seedLocal(): Promise<void> {
    await db.days.put(day(DATE, { weightAmKg: 74 }))
    await db.intake.put(intake('in_local', DATE))
    await putTargets({
      tdeeKcal: 2600,
      kcalTarget: 2100,
      proteinTargetG: 150,
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
  }

  const incoming = async (): Promise<ExportPackage> =>
    makePackage({
      days: [day(DATE, { weightAmKg: 80, sleepHours: 7 })],
      intake: [intake('in_file', DATE)],
      workout: [workout('wo_file', DATE)]
    })

  it('跳过（默认）：本机那一天的记录一条不动', async () => {
    await seedLocal()
    const report = await applyImport(await incoming(), { strategy: 'skip' })

    expect((await getDay(DATE))?.weightAmKg).toBe(74)
    expect((await listIntakeByDate(DATE)).map((row) => row.id)).toEqual(['in_local'])
    expect(await listWorkoutByDate(DATE)).toEqual([])
    expect(report.skipped).toEqual({ days: 1, intake: 1, workout: 1 })
  })

  it('合并：文件里的非空字段覆盖同名日期，条目按 id 并集', async () => {
    await seedLocal()
    const report = await applyImport(await incoming(), { strategy: 'merge' })

    const merged = await getDay(DATE)
    expect(merged?.weightAmKg).toBe(80)
    expect(merged?.sleepHours).toBe(7)
    expect(report.overriddenFields).toContain(`${DATE}.weightAmKg`)
    // 两边的摄入条目都在（不同 id）
    expect((await listIntakeByDate(DATE)).map((row) => row.id).sort()).toEqual(['in_file', 'in_local'])
    expect(await listWorkoutByDate(DATE)).toHaveLength(1)
  })

  it('覆盖：只动勾选的日期，没勾的按跳过处理', async () => {
    await seedLocal()
    await db.days.put(day('2026-10-14', { weightAmKg: 75 }))
    const pkg = await makePackage({
      days: [day(DATE, { weightAmKg: 80 }), day('2026-10-14', { weightAmKg: 90 })],
      intake: [intake('in_file', DATE)]
    })

    const report = await applyImport(pkg, { strategy: 'overwrite', overwriteDates: ['2026-10-14'] })

    // 勾选的 10-14 被整体替换；10-15 没勾 → 跳过
    expect((await getDay('2026-10-14'))?.weightAmKg).toBe(90)
    expect((await getDay(DATE))?.weightAmKg).toBe(74)
    expect(report.overwriteDates).toEqual(['2026-10-14'])
    expect(report.skipped.days).toBe(1)
  })
})

describe('食物库与单例', () => {
  it('食物按 nameNorm 去重：重名保留本地版本，不新增', async () => {
    await db.foods.put(food('鸡胸肉', { kcal: 133, source: 'seed' }))
    const pkg = await makePackage({ foods: [food('鸡胸肉', { kcal: 999 }), food('鸡蛋')] })

    const report = await applyImport(pkg, { strategy: 'merge' })
    expect(report.duplicateFoods).toBe(1)
    expect(report.added.foods).toBe(1)
    expect((await db.foods.get('鸡胸肉'))?.kcal).toBe(133)
    expect(await db.foods.get('鸡蛋')).toBeDefined()
  })

  it('设置按字段合并：本机已有的值不被冲掉，本机没有的才从文件补', async () => {
    await saveSettings({ mutedFields: ['蛋白质'] })
    const fromFile: SettingsRecord = {
      id: 'current',
      units: { weight: 'kg', energy: 'kcal' },
      weekStart: 7,
      theme: 'dark',
      reminders: [],
      mutedFields: ['克数', '时长'],
      lastBackupAt: 12345,
      updatedAt: 1
    }
    const pkg = await makePackage({ settings: fromFile })

    const report = await applyImport(pkg, { strategy: 'merge' })
    const settings = await db.settings.get('current')
    // 两边都有 → 本机为准（本机 theme 缺省是 'auto'）
    expect(settings?.mutedFields).toEqual(['蛋白质'])
    expect(settings?.theme).toBe('auto')
    // 本机没有 → 从文件补上，并写进报告
    expect(settings?.lastBackupAt).toBe(12345)
    expect(report.singletonFields).toContain('settings.lastBackupAt')
  })
})

describe('往返与汇总重算', () => {
  it('导入后重算汇总（§7.4 第 5 步），days.summarySnapshot 不再是空的', async () => {
    await putTargets({
      tdeeKcal: 2600,
      kcalTarget: 2100,
      proteinTargetG: 150,
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
    const pkg = await makePackage({ days: [day(DATE, { weightAmKg: 75 })], intake: [intake('in_1', DATE)] })

    const report = await applyImport(pkg, { strategy: 'skip' })
    expect(report.recomputedDays).toBe(1)
    const stored = await getDay(DATE)
    expect(stored?.summarySnapshot?.rows.find((row) => row.key === 'kcal')?.intake).toBe(120)
  })

  it('导出 → 清库 → 导入：数据等价', async () => {
    await db.days.put(day(DATE, { weightAmKg: 75.1 }))
    await db.intake.put(intake('in_1', DATE))
    await db.workout.put(workout('wo_1', DATE))
    await db.foods.put(food('测试食材'))
    await putTargets({
      tdeeKcal: 2600,
      kcalTarget: 2100,
      proteinTargetG: 150,
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

    const text = serializeExport(await buildExportPackage())
    const parsed = await parseExportPackage(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    await Promise.all(db.tables.map((table) => table.clear()))

    const strategy: ConflictStrategy = 'skip'
    await applyImport(parsed.pkg, { strategy })

    expect((await getDay(DATE))?.weightAmKg).toBe(75.1)
    expect((await listIntakeByDate(DATE)).map((row) => row.id)).toEqual(['in_1'])
    expect((await listWorkoutByDate(DATE)).map((row) => row.id)).toEqual(['wo_1'])
    expect((await getTargets())?.kcalTarget).toBe(2100)
    expect((await db.foods.get('测试食材'))?.name).toBe('测试食材')
  })
})
