/**
 * 快照载荷（T4.3 / FR-1208）：把「一天的全部数据」序列化成一段文本，以及把它读回来。
 *
 * 与 `io/markdown/record.ts` 的差别：那个是**跨工具**的格式，这个是**本应用自己的**
 * 内部格式，所以：
 * 1. 直接存领域对象（不转文本表格），回滚时能原样写回，连 `pendingFlag`、`summarySnapshot`
 *    这种派生字段都不丢；
 * 2. 读回来必须**先校验再用**：快照来自 IndexedDB，可能被别的版本或被手工改坏，
 *    回滚是破坏性操作，宁可整条拒绝也不「尽力而为地写半份数据」。
 *
 * 刻意不用 Zod：这里的字段要**原样落库**，而 Zod 默认会剥掉 schema 之外的键 ——
 * 剥掉就等于回滚时静默丢字段。所以用与 `io/importPackage.ts` 一样的手写结构检查。
 */

import type { DayRecord, IntakeEntry, WorkoutEntry } from '@/domain/types'

export const SNAPSHOT_FORMAT_VERSION = 1

export interface DaySnapshotPayload {
  formatVersion: number
  scope: 'day'
  /** 快照覆盖的那一天 */
  date: string
  takenAt: number
  /** 那一天没有 `days` 行时为空（只记了一餐、还没建头部的情况） */
  day?: DayRecord
  intake: IntakeEntry[]
  workout: WorkoutEntry[]
}

export interface DaySnapshotInput {
  date: string
  takenAt: number
  day?: DayRecord
  intake: IntakeEntry[]
  workout: WorkoutEntry[]
}

export function serializeDaySnapshot(input: DaySnapshotInput): string {
  const payload: DaySnapshotPayload = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    scope: 'day',
    date: input.date,
    takenAt: input.takenAt,
    day: input.day,
    intake: input.intake,
    workout: input.workout
  }
  return JSON.stringify(payload)
}

export type SnapshotParseResult =
  | { ok: true; payload: DaySnapshotPayload }
  | { ok: false; error: string }

/**
 * 「内容」指纹：只由那一天的**数据**决定，不含 `takenAt`。
 *
 * 用它做去重判断。不能直接比两段 JSON：`takenAt` 每次都不一样，比出来永远不相等；
 * 也不能比 `JSON.stringify(payload)`：那依赖键的书写顺序。用数组拼，顺序写死。
 */
export function snapshotContentKey(content: {
  date: string
  day?: DayRecord
  intake: IntakeEntry[]
  workout: WorkoutEntry[]
}): string {
  return JSON.stringify([content.date, content.day ?? null, content.intake, content.workout])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 行必须带 `id` 与 `date`：回滚要按它们写回去，缺了就没法还原。 */
function checkRows(value: unknown, label: string): string | undefined {
  if (!Array.isArray(value)) return `${label} 不是数组`
  for (const [index, row] of value.entries()) {
    if (!isRecord(row)) return `${label}[${index}] 不是对象`
    if (typeof row.id !== 'string' || !row.id) return `${label}[${index}] 缺少 id`
    if (typeof row.date !== 'string' || !row.date) return `${label}[${index}] 缺少 date`
  }
  return undefined
}

export function parseSnapshotPayload(text: string): SnapshotParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return { ok: false, error: `快照不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (!isRecord(raw)) return { ok: false, error: '快照内容不是一个对象' }
  const formatVersion = Number(raw.formatVersion)
  if (!Number.isFinite(formatVersion)) return { ok: false, error: '快照缺少 formatVersion' }
  if (formatVersion > SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `快照格式 v${formatVersion} 比本应用支持的 v${SNAPSHOT_FORMAT_VERSION} 新，请先升级应用`
    }
  }
  if (raw.scope !== 'day') return { ok: false, error: `只支持日快照，这条是 ${String(raw.scope)}` }
  if (typeof raw.date !== 'string' || !raw.date) return { ok: false, error: '快照缺少 date' }
  if (raw.day !== undefined && !isRecord(raw.day)) return { ok: false, error: '快照的 day 不是对象' }
  if (raw.day !== undefined && typeof (raw.day as Record<string, unknown>).date !== 'string') {
    return { ok: false, error: '快照的 day 缺少 date' }
  }
  const intakeError = checkRows(raw.intake, 'intake')
  if (intakeError) return { ok: false, error: intakeError }
  const workoutError = checkRows(raw.workout, 'workout')
  if (workoutError) return { ok: false, error: workoutError }

  return {
    ok: true,
    payload: {
      formatVersion,
      scope: 'day',
      date: raw.date,
      takenAt: typeof raw.takenAt === 'number' ? raw.takenAt : 0,
      day: raw.day as DayRecord | undefined,
      intake: raw.intake as IntakeEntry[],
      workout: raw.workout as WorkoutEntry[]
    }
  }
}
