import Dexie, { type Table } from 'dexie'
import type {
  AdviceRecord,
  CalibrationRecord,
  DayRecord,
  DraftRecord,
  Food,
  IntakeEntry,
  LlmLog,
  MetaRecord,
  ModelConfigRecord,
  PendingOp,
  PlanRecord,
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
 * v2：新增 `drafts`（澄清未完成的草稿，§6.12），其余表结构不变。
 * v3：新增 `adviceLog`（每日指导与「采纳 / 不采纳」表态，§6.4.2），其余表结构不变。
 * v4：新增 `plans`（B 级生成式推荐的当日缓存，§6.2 / T3.8），其余表结构不变。
 *
 * **每个版本只声明这一版新增的存储**，绝不写成「当前版本 + 全量表」——
 * 那样一来 `version(2)` 会被理解成「v2 里只有这几张表」，1 → 2 的升级会把其余存储全删掉，
 * 老用户的数据会当场蒸发（2026-10-16 加 v3 时踩到过，`db.spec.ts` 的迁移用例守着这条）。
 */
export const SCHEMA_VERSION = 4

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
  adviceLog!: Table<AdviceRecord, string>
  plans!: Table<PlanRecord, string>
  meta!: Table<MetaRecord, string>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(1).stores({
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
    this.version(3).stores({ adviceLog: 'id, date, createdAt' })
    this.version(4).stores({ plans: 'id, date, kind' })
  }
}

export const db = new ThinMusclePlanDb()
