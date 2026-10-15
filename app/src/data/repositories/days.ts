import { db } from '../db'
import { toPlain } from '../plain'
import type { DayRecord, DaySummary } from '@/domain/types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function weekdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return WEEKDAYS[d.getDay()]
}

export async function getDay(date: string): Promise<DayRecord | undefined> {
  return db.days.get(date)
}

/** 幂等创建当日记录：已存在时原样返回，不覆盖（FR-101）。 */
export async function ensureDay(date: string): Promise<DayRecord> {
  const existing = await getDay(date)
  if (existing) return existing
  const now = Date.now()
  const day: DayRecord = { date, weekday: weekdayOf(date), pendingCount: 0, createdAt: now, updatedAt: now }
  await db.days.put(day)
  return day
}

export async function updateDay(date: string, patch: Partial<DayRecord>): Promise<void> {
  await ensureDay(date)
  await db.days.update(date, toPlain({ ...patch, updatedAt: Date.now() }))
}

export async function saveSummary(date: string, summary: DaySummary): Promise<void> {
  await db.days.update(
    date,
    toPlain({ summarySnapshot: summary, pendingCount: summary.pendingCount, updatedAt: Date.now() })
  )
}

export async function listDaysInRange(start: string, end: string): Promise<DayRecord[]> {
  return db.days.where('date').between(start, end, true, true).toArray()
}

export async function listRecentDays(limit: number, end: string): Promise<DayRecord[]> {
  const all = await db.days.orderBy('date').reverse().limit(limit).toArray()
  return all.filter((d) => d.date <= end).sort((a, b) => a.date.localeCompare(b.date))
}
