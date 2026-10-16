/**
 * 快照仓储（T4.3 / FR-1208）。
 *
 * `snapshots` 表从 schema v1 就建了，但一直没人用过（见 docs/pwa-progress.md §4.2）。
 * 这里给它一套最小 CRUD：**快照是安全网，不是历史版本管理** —— 所以写入后只保留最近
 * `SNAPSHOT_KEEP` 条（`pruneSnapshots`），既不会无限长大，也不承诺「永远留着」。
 *
 * 载荷（`payload`）是文本，内容与校验在 `io/snapshot.ts`：仓储层只负责存取，
 * 这样「回滚前先校验」这类纪律不会被仓储的便利方法绕过去。
 */

import { db } from '../db'
import { toPlain } from '../plain'
import { newId } from './intake'
import type { SnapshotRecord } from '@/domain/types'

/** 保留条数：一条日快照通常是十几 KB，100 条足够覆盖「手滑删了一堆」的场景。 */
export const SNAPSHOT_KEEP = 100

export interface SnapshotInput {
  /** 快照覆盖的那一天（`full` 类快照取拍照当天） */
  date: string
  /** 给用户看的一句话：为什么拍的（「导入覆盖前自动快照」…） */
  reason: string
  payload: string
}

export async function saveSnapshot(input: SnapshotInput): Promise<SnapshotRecord> {
  const record: SnapshotRecord = {
    id: newId('snap'),
    date: input.date,
    reason: input.reason,
    payload: input.payload,
    createdAt: Date.now()
  }
  await db.snapshots.put(toPlain(record))
  await pruneSnapshots()
  return record
}

export async function getSnapshot(id: string): Promise<SnapshotRecord | undefined> {
  return db.snapshots.get(id)
}

export async function countSnapshots(): Promise<number> {
  return db.snapshots.count()
}

/** 最新在前。`createdAt` 不是索引，取回后在内存里排（总条数有上限，无所谓）。 */
export async function listSnapshots(limit = 30): Promise<SnapshotRecord[]> {
  const rows = await db.snapshots.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export async function listSnapshotsByDate(date: string): Promise<SnapshotRecord[]> {
  const rows = await db.snapshots.where('date').equals(date).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/** 某一天最新的一条快照（`captureDay` 用它去重）。 */
export async function latestSnapshotForDate(date: string): Promise<SnapshotRecord | undefined> {
  const [latest] = await listSnapshotsByDate(date)
  return latest
}

export async function removeSnapshot(id: string): Promise<void> {
  await db.snapshots.delete(id)
}

/** 只保留最近 `keep` 条；返回删掉的条数。 */
export async function pruneSnapshots(keep = SNAPSHOT_KEEP): Promise<number> {
  const rows = await db.snapshots.toArray()
  if (rows.length <= keep) return 0
  const doomed = rows.sort((a, b) => b.createdAt - a.createdAt).slice(keep)
  await db.snapshots.bulkDelete(doomed.map((row) => row.id))
  return doomed.length
}
