/**
 * 快照与单日回滚（T4.3 / FR-1208，design §4.3 的「失败可回滚」）。
 *
 * 三件事：
 * 1. **自动快照**：任何可能毁数据的写操作之前先拍一张（导入覆盖 / 合并、删除单条记录），
 *    理由写进 `reason`，用户在数据页看得见「为什么会有这一条」；
 * 2. **单日回滚**：把某一天的头部 + 摄入 + 训练整体还原成快照里的样子，然后按本地口径重算汇总；
 * 3. **回滚本身可回滚**：动手之前先给「当前状态」拍一张，所以误点了回滚也能再回去。
 *
 * 回滚写的是**整天的替换**（先删这一天的三张表再写回），因此必须放在一个事务里 ——
 * 半份数据（删了旧的、没写回新的）比不回滚更糟。
 */

import { db } from '@/data/db'
import { toPlain } from '@/data/plain'
import { ensureDay, getDay } from '@/data/repositories/days'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listWorkoutByDate } from '@/data/repositories/workout'
import {
  getSnapshot,
  latestSnapshotForDate,
  listSnapshots,
  saveSnapshot
} from '@/data/repositories/snapshots'
import { parseSnapshotPayload, serializeDaySnapshot, snapshotContentKey } from '@/io/snapshot'
import { recomputeDaySummary } from '@/application/daySummary'
import type { SnapshotRecord } from '@/domain/types'

export interface SnapshotSummary {
  id: string
  date: string
  reason: string
  createdAt: number
  counts: { intake: number; workout: number }
  /** 载荷读不出来（被改坏 / 未来版本）：界面上标一下，别让用户以为它能回滚 */
  broken: boolean
  /** 与同一天上一条快照内容相同、因此没有重复写库 */
  deduped: boolean
}

export function summarizeSnapshot(record: SnapshotRecord): SnapshotSummary {
  const parsed = parseSnapshotPayload(record.payload)
  return {
    id: record.id,
    date: record.date,
    reason: record.reason,
    createdAt: record.createdAt,
    counts: parsed.ok
      ? { intake: parsed.payload.intake.length, workout: parsed.payload.workout.length }
      : { intake: 0, workout: 0 },
    broken: !parsed.ok,
    deduped: false
  }
}

/**
 * 给某一天拍一张快照。
 *
 * 内容与同一天上一条快照完全一致时**不重复写**（返回那一条并标 `deduped`）：
 * 「删除条目前的自动快照」这类调用很密集，一模一样的安全网留一百份没有意义。
 */
export async function captureDay(date: string, reason: string): Promise<SnapshotSummary> {
  const [day, intake, workout] = await Promise.all([
    getDay(date),
    listIntakeByDate(date),
    listWorkoutByDate(date)
  ])
  const payload = serializeDaySnapshot({ date, takenAt: Date.now(), day, intake, workout })
  const previous = await latestSnapshotForDate(date)
  if (previous) {
    const parsed = parseSnapshotPayload(previous.payload)
    // 比「内容」而不是比两段 JSON：`takenAt` 每次都不一样（见 `snapshotContentKey`）
    if (parsed.ok && snapshotContentKey(parsed.payload) === snapshotContentKey({ date, day, intake, workout })) {
      return { ...summarizeSnapshot(previous), deduped: true }
    }
  }
  const record = await saveSnapshot({ date, reason, payload })
  return { ...summarizeSnapshot(record), deduped: false }
}

/** 最新的在前。 */
export async function listSnapshotSummaries(limit = 20): Promise<SnapshotSummary[]> {
  return (await listSnapshots(limit)).map(summarizeSnapshot)
}

export interface RestoreReport {
  date: string
  restored: { day: boolean; intake: number; workout: number }
  /** 回滚前本机是什么样（好让用户判断「我刚才是不是回滚错版本了」） */
  replaced: { day: boolean; intake: number; workout: number }
  /** 回滚前自动拍的那一条：回滚本身也能再回滚 */
  backupId: string
  /** 汇总有没有重算出来（那天连头部都没有时为 false） */
  summaryRecomputed: boolean
}

export async function restoreDaySnapshot(id: string): Promise<RestoreReport> {
  const record = await getSnapshot(id)
  if (!record) throw new Error('这条快照已经不存在了（可能已经被「只保留最近若干条」清掉）')
  const parsed = parseSnapshotPayload(record.payload)
  if (!parsed.ok) throw new Error(`快照读不出来，未做任何改动：${parsed.error}`)
  const { payload } = parsed
  const date = payload.date

  const [currentDay, currentIntake, currentWorkout] = await Promise.all([
    getDay(date),
    listIntakeByDate(date),
    listWorkoutByDate(date)
  ])
  const backup = await captureDay(date, '回滚前自动快照')

  await db.transaction('rw', db.days, db.intake, db.workout, async () => {
    await db.intake.where('date').equals(date).delete()
    await db.workout.where('date').equals(date).delete()
    if (payload.day) await db.days.put(toPlain({ ...payload.day, date }))
    else await db.days.delete(date)
    for (const row of payload.intake) await db.intake.put(toPlain({ ...row, date }))
    for (const row of payload.workout) await db.workout.put(toPlain({ ...row, date }))
  })

  // 快照里没有头部却有条目（只记了一餐、还没建 `days` 行）：补一个，否则这一天会从界面上消失
  if (!payload.day && (payload.intake.length || payload.workout.length)) await ensureDay(date)

  return {
    date,
    restored: { day: Boolean(payload.day), intake: payload.intake.length, workout: payload.workout.length },
    replaced: {
      day: Boolean(currentDay),
      intake: currentIntake.length,
      workout: currentWorkout.length
    },
    backupId: backup.id,
    summaryRecomputed: await recomputeDaySummary(date)
  }
}
