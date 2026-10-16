/**
 * 导出包（T4.1 / design §7.1，FR-1204 / FR-1207）。
 *
 * 单文件 JSON：`{ manifest, data, checksum }`。选 JSON 而不是 zip 是为了 iOS 上能直接分享、
 * 也能用文本编辑器看一眼（FR-1206 的"不被应用锁定"）。
 *
 * 两条硬规矩：
 * 1. **绝不导出 `modelConfig` 与 `llmLogs`**（FR-1305）：token 只存本机，日志里也可能带调用痕迹。
 *    导出前的界面必须把这一点说清楚。
 * 2. **校验和算在规范化 JSON 上**：对象键递归排序后再哈希，否则同一份数据换个键序就得到不同的
 *    校验和，导入时会把完好的文件判成"被改过"。
 */

import { db, SINGLETON_KEY, SCHEMA_VERSION } from '@/data/db'
import { todayIso } from '@/app/date'
import { APP_VERSION } from '@/app/version'
import type {
  AdviceRecord,
  CalibrationRecord,
  DayRecord,
  DraftRecord,
  Food,
  IntakeEntry,
  PendingOp,
  PlanRecord,
  ProfileRecord,
  ReportRecord,
  SettingsRecord,
  SnapshotRecord,
  TargetsRecord,
  WorkoutEntry
} from '@/domain/types'

export const EXPORT_APP = 'thin-muscle-plan'
export const EXPORT_FORMAT_VERSION = 1

/**
 * `data` 里**有**的块。刻意没有 `modelConfig` / `llmLogs` / `meta`：
 * 前两个是 FR-1305 明令不导出的，`meta` 只是本机的启动标记（种子版本等），换个设备本来就该重算。
 */
export interface ExportData {
  days: DayRecord[]
  intake: IntakeEntry[]
  workout: WorkoutEntry[]
  foods: Food[]
  reports: ReportRecord[]
  targets?: TargetsRecord
  calibrations: CalibrationRecord[]
  profile?: ProfileRecord
  settings?: SettingsRecord
  snapshots: SnapshotRecord[]
  pendingOps: PendingOp[]
  drafts: DraftRecord[]
  adviceLog: AdviceRecord[]
  plans: PlanRecord[]
}

export interface ExportManifest {
  app: string
  formatVersion: number
  schemaVersion: number
  exportedAt: string
  appVersion: string
  /** 各块条目数，供用户事后核对文件是否完整 */
  counts: Record<string, number>
}

export interface ExportPackage {
  manifest: ExportManifest
  data: ExportData
  checksum: string
}

/** 规范化 JSON：对象键递归排序、丢掉 `undefined` 的键，数组保持原序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/** `sha256(规范化 JSON)` 的十六进制写法。 */
export async function checksumOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** 读出要导出的全部数据（不碰 `modelConfig` / `llmLogs`）。 */
export async function buildExportData(): Promise<ExportData> {
  const [
    days,
    intake,
    workout,
    foods,
    reports,
    targets,
    calibrations,
    profile,
    settings,
    snapshots,
    pendingOps,
    drafts,
    adviceLog,
    plans
  ] = await Promise.all([
    db.days.toArray(),
    db.intake.toArray(),
    db.workout.toArray(),
    db.foods.toArray(),
    db.reports.toArray(),
    db.targets.get(SINGLETON_KEY),
    db.calibrations.toArray(),
    db.profile.get(SINGLETON_KEY),
    db.settings.get(SINGLETON_KEY),
    db.snapshots.toArray(),
    db.pendingOps.toArray(),
    db.drafts.toArray(),
    db.adviceLog.toArray(),
    db.plans.toArray()
  ])
  return { days, intake, workout, foods, reports, targets, calibrations, profile, settings, snapshots, pendingOps, drafts, adviceLog, plans }
}

function countsOf(data: ExportData): Record<string, number> {
  return {
    days: data.days.length,
    intake: data.intake.length,
    workout: data.workout.length,
    foods: data.foods.length,
    reports: data.reports.length,
    calibrations: data.calibrations.length,
    snapshots: data.snapshots.length,
    pendingOps: data.pendingOps.length,
    drafts: data.drafts.length,
    adviceLog: data.adviceLog.length,
    plans: data.plans.length,
    targets: data.targets ? 1 : 0,
    profile: data.profile ? 1 : 0,
    settings: data.settings ? 1 : 0
  }
}

/** 组装完整导出包（含 manifest 与 checksum）。 */
export async function buildExportPackage(now = new Date()): Promise<ExportPackage> {
  const data = await buildExportData()
  return {
    manifest: {
      app: EXPORT_APP,
      formatVersion: EXPORT_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: now.toISOString(),
      appVersion: APP_VERSION,
      counts: countsOf(data)
    },
    data,
    checksum: await checksumOf(data)
  }
}

export function exportFileName(date = todayIso()): string {
  return `薄肌计划-export-${date}.json`
}

/** 落盘用的文本（缩进 2 空格，方便用户自己看一眼）。 */
export function serializeExport(pkg: ExportPackage): string {
  return JSON.stringify(pkg, null, 2)
}
