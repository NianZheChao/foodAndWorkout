/**
 * 导入（T4.1 / design §7.4，FR-1205 / FR-1207）。
 *
 * 三步：**校验 → 预览差异 → 按冲突策略落库**。校验失败（不是本应用的文件、格式版本更新、
 * 校验和不符）一律**整包拒绝**（§10.1 的数据完整性错误），不给"部分导入"的口子；
 * 先给用户看预演，他才知道自己在改什么。
 *
 * 刻意**不用一个事务包住整包**：单条数据不合法时应该只影响那一条，
 * 而一个大事务会把已经合理的部分一起回滚，与「其余继续导入」的设计相悖。
 * 代价是可能落下半包数据 —— 所以每次导入都会给一份「成功 / 跳过 / 冲突」报告。
 */

import { db, SCHEMA_VERSION, SINGLETON_KEY } from '@/data/db'
import { toPlain } from '@/data/plain'
import { recomputeDaySummary } from '@/application/daySummary'
import { captureDay } from '@/application/snapshot'
import { checksumOf, EXPORT_APP, EXPORT_FORMAT_VERSION, type ExportData, type ExportPackage } from './exportPackage'
import type {
  DayRecord,
  ProfileRecord,
  SettingsRecord,
  TargetsRecord
} from '@/domain/types'

/** 冲突策略：默认安全（跳过）。 */
export type ConflictStrategy = 'skip' | 'merge' | 'overwrite'

export type ParseResult = { ok: true; pkg: ExportPackage } | { ok: false; error: string }

const ARRAY_KEYS = [
  'days',
  'intake',
  'workout',
  'foods',
  'reports',
  'calibrations',
  'snapshots',
  'pendingOps',
  'drafts',
  'adviceLog',
  'plans'
] as const

/**
 * 校验并解析导出包。
 *
 * 顺序是刻意的：先看是不是本应用的文件（否则后面的报错都会很莫名其妙），
 * 再看版本（新版本的文件可能带本应用读不懂的字段），最后才验校验和。
 */
export async function parseExportPackage(text: string): Promise<ParseResult> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return { ok: false, error: `文件不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: '文件内容不是一个对象' }

  const candidate = raw as Partial<ExportPackage>
  const manifest = candidate.manifest
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: '文件缺少 manifest，不是本应用导出的包' }
  if (manifest.app !== EXPORT_APP) {
    return { ok: false, error: `这不是本应用导出的文件（app=${String(manifest.app)}）` }
  }
  const formatVersion = Number(manifest.formatVersion)
  if (!Number.isFinite(formatVersion)) return { ok: false, error: 'manifest.formatVersion 不是数字' }
  if (formatVersion > EXPORT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `文件的格式版本 v${formatVersion} 比本应用支持的 v${EXPORT_FORMAT_VERSION} 新，请先升级应用再导入`
    }
  }
  const schemaVersion = Number(manifest.schemaVersion)
  if (Number.isFinite(schemaVersion) && schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `文件的数据库版本 v${schemaVersion} 比本机的 v${SCHEMA_VERSION} 新，请先升级应用再导入`
    }
  }

  const data = candidate.data
  if (!data || typeof data !== 'object') return { ok: false, error: '文件缺少 data 块' }

  const expected = await checksumOf(data)
  if (typeof candidate.checksum !== 'string' || candidate.checksum !== expected) {
    return {
      ok: false,
      error: `校验和不符：文件可能被改动或损坏（文件写的是 ${String(candidate.checksum).slice(0, 8)}…，重算是 ${expected.slice(0, 8)}…）`
    }
  }

  return { ok: true, pkg: normalizePackage(candidate as ExportPackage, data as ExportData) }
}

/** 缺的块补成空数组：老版本导出的包里没有 `drafts` / `adviceLog` 也不该报错。 */
function normalizePackage(pkg: ExportPackage, data: ExportData): ExportPackage {
  const normalized = { ...data } as Record<string, unknown>
  for (const key of ARRAY_KEYS) if (!Array.isArray(normalized[key])) normalized[key] = []
  return { ...pkg, data: normalized as unknown as ExportData }
}

export interface ImportPreview {
  counts: Record<string, number>
  /** 文件里有、本机也有记录的日期（升序） */
  conflictDates: string[]
  /** 文件里有、本机没有记录的日期（升序） */
  newDates: string[]
  newFoods: number
  duplicateFoods: number
  /** 单例对象是否要"与本地合并"（而不是"本机还没有"） */
  singletons: { targets: boolean; profile: boolean; settings: boolean }
}

function datesOf(data: Pick<ExportData, 'days' | 'intake' | 'workout'>): Set<string> {
  const dates = new Set<string>()
  for (const row of data.days) dates.add(row.date)
  for (const row of data.intake) dates.add(row.date)
  for (const row of data.workout) dates.add(row.date)
  return dates
}

export async function previewImport(pkg: ExportPackage): Promise<ImportPreview> {
  const data = pkg.data
  const [localDays, localIntake, localWorkout, localFoods, targets, profile, settings] = await Promise.all([
    db.days.toArray(),
    db.intake.toArray(),
    db.workout.toArray(),
    db.foods.toArray(),
    db.targets.get(SINGLETON_KEY),
    db.profile.get(SINGLETON_KEY),
    db.settings.get(SINGLETON_KEY)
  ])
  const incoming = datesOf(data)
  const local = datesOf({ days: localDays, intake: localIntake, workout: localWorkout })
  const localFoodNames = new Set(localFoods.map((food) => food.nameNorm))
  const duplicateFoods = data.foods.filter((food) => localFoodNames.has(food.nameNorm)).length
  return {
    counts: pkg.manifest.counts ?? {},
    conflictDates: [...incoming].filter((date) => local.has(date)).sort(),
    newDates: [...incoming].filter((date) => !local.has(date)).sort(),
    newFoods: data.foods.length - duplicateFoods,
    duplicateFoods,
    singletons: { targets: !!targets && !!data.targets, profile: !!profile && !!data.profile, settings: !!settings && !!data.settings }
  }
}

export interface ImportOptions {
  strategy: ConflictStrategy
  /** 只在 `overwrite` 下生效：用户显式勾选要覆盖的日期；缺省 = 全部冲突日期 */
  overwriteDates?: string[]
  /** 跳过导入后的汇总重算（测试里省时间用） */
  skipRecompute?: boolean
}

export interface ImportReport {
  strategy: ConflictStrategy
  conflictDates: string[]
  overwriteDates: string[]
  added: Record<string, number>
  skipped: { days: number; intake: number; workout: number }
  /** 合并时被文件的非空值盖掉的字段（`日期.字段`），如 `2026-10-15.weightAmKg` */
  overriddenFields: string[]
  duplicateFoods: number
  /** 从文件补上的单例字段（本机为空、文件有值的那些） */
  singletonFields: string[]
  recomputedDays: number
  /** 动手之前自动拍的快照张数（FR-1208）；「跳过」策略不拍，为 0 */
  snapshots: number
}

const EMPTY = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)

/** 逐字段合并：本机为空就取文件的；两边都有就取文件的（并记一笔"被覆盖"）。 */
function mergeFields<T extends object>(
  local: T | undefined,
  incoming: T,
  fields: readonly (keyof T)[],
  labelOf: (field: string) => string,
  overridden: string[]
): T {
  const merged = { ...(local ?? ({} as T)) }
  for (const field of fields) {
    const fromFile = incoming[field]
    if (EMPTY(fromFile)) continue
    if (!EMPTY(merged[field])) overridden.push(labelOf(String(field)))
    merged[field] = fromFile
  }
  return merged
}

const DAY_FIELDS = ['weightAmKg', 'weightPmKg', 'sleepHours', 'energy', 'soreness', 'note', 'todos'] as const
const TARGETS_FIELDS = [
  'tdeeKcal',
  'kcalTarget',
  'proteinTargetG',
  'fatTargetG',
  'carbTargetG',
  'fiberTargetG',
  'sodiumMaxMg',
  'weeklyTrainingDays',
  'weeklySetsPerMuscle',
  'targetWeightKg',
  'targetRateKgPerWeek',
  'reviewCadence',
  'lastCalibrated'
] as const
const PROFILE_FIELDS = [
  'name',
  'sex',
  'age',
  'heightCm',
  'weightKg',
  'bodyFatPct',
  'goal',
  'trainingLevel',
  'trainingYears',
  'wakeTime',
  'sleepTime',
  'conventions',
  // T3.8：B 级推荐的四项安全边界（FR-1003），别在导入时把它们丢掉
  'avoidFoods',
  'allergies',
  'equipment',
  'mealMinutes'
] as const
const SETTINGS_FIELDS = ['units', 'weekStart', 'theme', 'reminders', 'mutedFields', 'shareRecovery', 'recommendEnabled', 'lastBackupAt'] as const

/** 某一天的摄入 / 训练该怎么处理：返回要写入的行；`undefined` = 整日跳过。 */
function planByDate<T extends { date: string }>(
  date: string,
  rows: readonly T[],
  conflictSet: Set<string>,
  options: ImportOptions,
  overwriteSet: Set<string>
): readonly T[] | undefined {
  if (!conflictSet.has(date)) return rows
  if (options.strategy === 'skip') return undefined
  if (options.strategy === 'overwrite') return overwriteSet.has(date) ? rows : undefined
  return rows
}

/** 按 id 并集：只补本机没有的 id，已有的原样保留。 */
async function unionInto<T extends { id: string }>(
  table: { toArray(): Promise<T[]>; put(row: T): Promise<unknown> },
  rows: readonly T[]
): Promise<number> {
  const existing = new Set((await table.toArray()).map((row) => row.id))
  let added = 0
  for (const row of rows) {
    if (existing.has(row.id)) continue
    await table.put(toPlain(row))
    added += 1
  }
  return added
}

/**
 * 落库。
 *
 * 顺序：算冲突集合 → 覆盖策略先删本地的冲突日 → 按日期处理三个"按日期分区"的表 →
 * 食物库按 `nameNorm` 去重 → 单例逐字段合并 → 其余按 id 并集 → 重算受影响日期的汇总（§7.4 第 5 步）。
 */
export async function applyImport(pkg: ExportPackage, options: ImportOptions): Promise<ImportReport> {
  const data = pkg.data
  const preview = await previewImport(pkg)
  const conflictSet = new Set(preview.conflictDates)
  const overwriteSet = new Set(
    options.strategy === 'overwrite' ? (options.overwriteDates ?? preview.conflictDates) : []
  )

  const report: ImportReport = {
    strategy: options.strategy,
    conflictDates: preview.conflictDates,
    overwriteDates: [...overwriteSet].sort(),
    added: {},
    skipped: { days: 0, intake: 0, workout: 0 },
    overriddenFields: [],
    duplicateFoods: 0,
    singletonFields: [],
    recomputedDays: 0,
    /** 导入前自动拍的快照张数（FR-1208） */
    snapshots: 0
  }
  const bump = (key: string, count = 1): void => {
    report.added[key] = (report.added[key] ?? 0) + count
  }
  const touched = new Set<string>()

  // 动手之前先给「马上要改掉的日期」各拍一张快照（FR-1208 的自动快照）：
  // 合并会改到全部冲突日，覆盖只会改勾选的那些，「跳过」本机完全不动所以不拍。
  // 快照写不进去（配额满 / 库打不开）时直接抛错打断导入 —— 带着「以为有安全网」的错觉继续写
  // 比导入失败更糟。
  const snapshotDates = options.strategy === 'overwrite' ? [...overwriteSet] : options.strategy === 'merge' ? preview.conflictDates : []
  for (const date of snapshotDates) {
    await captureDay(date, options.strategy === 'overwrite' ? '导入覆盖前自动快照' : '导入合并前自动快照')
    report.snapshots += 1
  }

  // 覆盖策略：先删掉本地那一天的三个表再整体写入。危险操作，只有显式勾选的日期才做。
  for (const date of overwriteSet) {
    await db.days.delete(date)
    await db.intake.where('date').equals(date).delete()
    await db.workout.where('date').equals(date).delete()
    touched.add(date)
  }

  for (const day of data.days) {
    const conflict = conflictSet.has(day.date)
    if (conflict && (options.strategy === 'skip' || !overwriteSet.has(day.date) && options.strategy === 'overwrite')) {
      report.skipped.days += 1
      continue
    }
    const merge = conflict && options.strategy === 'merge'
    const existing = merge ? await db.days.get(day.date) : undefined
    const merged = existing
      ? mergeFields<DayRecord>(existing, day, DAY_FIELDS, (field) => `${day.date}.${field}`, report.overriddenFields)
      : day
    await db.days.put(
      toPlain({
        ...merged,
        date: day.date,
        weekday: merged.weekday || day.weekday,
        // 汇总快照永远本地重算，不采信文件里的（§7.3「AUTO 区块内容不信任」）
        summarySnapshot: existing?.summarySnapshot,
        pendingCount: existing?.pendingCount ?? day.pendingCount ?? 0,
        createdAt: existing?.createdAt ?? day.createdAt ?? Date.now(),
        updatedAt: Date.now()
      })
    )
    touched.add(day.date)
    bump('days')
  }

  const intakeByDate = groupByDate(data.intake)
  for (const [date, rows] of intakeByDate) {
    const planned = planByDate(date, rows, conflictSet, options, overwriteSet)
    if (!planned) {
      report.skipped.intake += rows.length
      continue
    }
    const existingIds = new Set((await db.intake.where('date').equals(date).toArray()).map((row) => row.id))
    for (const row of planned) {
      if (existingIds.has(row.id)) continue
      await db.intake.put(toPlain(row))
      bump('intake')
    }
    touched.add(date)
  }

  const workoutByDate = groupByDate(data.workout)
  for (const [date, rows] of workoutByDate) {
    const planned = planByDate(date, rows, conflictSet, options, overwriteSet)
    if (!planned) {
      report.skipped.workout += rows.length
      continue
    }
    const existingIds = new Set((await db.workout.where('date').equals(date).toArray()).map((row) => row.id))
    for (const row of planned) {
      if (existingIds.has(row.id)) continue
      await db.workout.put(toPlain(row))
      bump('workout')
    }
    touched.add(date)
  }

  // 食物库按 nameNorm 去重：冲突时保留本地版本，导入版本只记成"疑似别名"（§7.4 第 4 步）
  const localFoodNames = new Set((await db.foods.toArray()).map((food) => food.nameNorm))
  for (const food of data.foods) {
    if (localFoodNames.has(food.nameNorm) || (await db.foods.get(food.id))) {
      report.duplicateFoods += 1
      continue
    }
    await db.foods.put(toPlain(food))
    localFoodNames.add(food.nameNorm)
    bump('foods')
  }

  report.singletonFields.push(
    ...(await mergeSingleton('targets', data.targets, TARGETS_FIELDS, report)),
    ...(await mergeSingleton('profile', data.profile, PROFILE_FIELDS, report)),
    ...(await mergeSingleton('settings', data.settings, SETTINGS_FIELDS, report))
  )

  bump('reports', await unionInto(db.reports, data.reports))
  bump('calibrations', await unionInto(db.calibrations, data.calibrations))
  bump('snapshots', await unionInto(db.snapshots, data.snapshots))
  bump('pendingOps', await unionInto(db.pendingOps, data.pendingOps))
  bump('drafts', await unionInto(db.drafts, data.drafts))
  bump('adviceLog', await unionInto(db.adviceLog, data.adviceLog))
  bump('plans', await unionInto(db.plans, data.plans))

  if (!options.skipRecompute) {
    for (const date of [...touched].sort()) if (await recomputeDaySummary(date)) report.recomputedDays += 1
  }
  return report
}

function groupByDate<T extends { date: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const bucket = grouped.get(row.date)
    if (bucket) bucket.push(row)
    else grouped.set(row.date, [row])
  }
  return grouped
}

/**
 * 单例合并：**绝不整体覆盖**（会把本机的「不再追问」名单冲掉）。
 * 本机为空的字段用文件补上并回报；两边都有时以**本机**为准（这台设备的口径优先）。
 */
async function mergeSingleton<K extends 'targets' | 'profile' | 'settings'>(
  kind: K,
  fromFile: TargetsRecord | ProfileRecord | SettingsRecord | undefined,
  fields: readonly string[],
  report: ImportReport
): Promise<string[]> {
  const table = db[kind] as unknown as {
    get(key: string): Promise<Record<string, unknown> | undefined>
    put(row: Record<string, unknown>): Promise<unknown>
  }
  const local = await table.get(SINGLETON_KEY)
  if (!fromFile) return []
  const filled: string[] = []
  const merged: Record<string, unknown> = { ...(local ?? {}) }
  for (const field of fields) {
    const incoming = (fromFile as unknown as Record<string, unknown>)[field]
    if (EMPTY(incoming)) continue
    if (!EMPTY(merged[field])) {
      report.overriddenFields.push(`${kind}.${field}（以本机为准）`)
      continue
    }
    merged[field] = incoming
    filled.push(`${kind}.${field}`)
  }
  await table.put(toPlain({ ...merged, id: SINGLETON_KEY, updatedAt: local?.updatedAt ?? Date.now() }))
  return filled
}
