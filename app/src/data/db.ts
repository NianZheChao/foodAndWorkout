import Dexie, { type Table } from 'dexie'
import type {
  CalibrationRecord,
  DayRecord,
  DraftRecord,
  Food,
  IntakeEntry,
  LlmLog,
  MetaRecord,
  ModelConfigRecord,
  PendingOp,
  ProfileRecord,
  ReportRecord,
  SettingsRecord,
  SnapshotRecord,
  TargetsRecord,
  WorkoutEntry
} from '@/domain/types'

export const DB_NAME = 'thin-muscle-plan'
/**
 * v1：初始表结构。
 * v2：新增 `drafts`（澄清未完成的草稿，§6.12），其余表结构不变 —— 只需声明新增的表，
 *     Dexie 会保留 v1 里已声明的存储，无需重复书写。
 */
export const SCHEMA_VERSION = 2

/** 单例对象存储使用固定主键 */
export const SINGLETON_KEY = 'current'

/**
 * IndexedDB 只接受 string / number / Date / ArrayBuffer / Array 作为索引键，
 * 布尔值不能作键：所有布尔语义的索引字段一律用 0/1（Flag）。
 */
export class ThinMusclePlanDb extends Dexie {
  days!: Table<DayRecord, string>
  intake!: Table<IntakeEntry, string>
  workout!: Table<WorkoutEntry, string>
  foods!: Table<Food, string>
  reports!: Table<ReportRecord, string>
  targets!: Table<TargetsRecord, string>
  calibrations!: Table<CalibrationRecord, string>
  profile!: Table<ProfileRecord, string>
  settings!: Table<SettingsRecord, string>
  snapshots!: Table<SnapshotRecord, string>
  pendingOps!: Table<PendingOp, string>
  llmLogs!: Table<LlmLog, string>
  modelConfig!: Table<ModelConfigRecord, string>
  drafts!: Table<DraftRecord, string>
  meta!: Table<MetaRecord, string>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(SCHEMA_VERSION).stores({
      days: 'date',
      intake: 'id, date, meal, foodId, pendingFlag',
      workout: 'id, date, exercise, type',
      foods: 'id, name, nameNorm, category, source, disabledFlag',
      reports: 'id, type, periodStart, status',
      targets: 'id',
      calibrations: 'id, date',
      profile: 'id',
      settings: 'id',
      snapshots: 'id, date',
      pendingOps: 'id, kind, status, createdAt',
      llmLogs: 'id, taskId, createdAt',
      modelConfig: 'id',
      meta: 'key'
    })
    this.version(2).stores({ drafts: 'id, date, status' })
  }
}

export const db = new ThinMusclePlanDb()
