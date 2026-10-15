import { db } from '../db'
import { toPlain } from '../plain'
import type { ReportRecord, ReportType } from '@/domain/types'

export async function listReports(type?: ReportType): Promise<ReportRecord[]> {
  const rows = type ? await db.reports.where('type').equals(type).toArray() : await db.reports.toArray()
  return rows.sort((a, b) => b.periodStart.localeCompare(a.periodStart))
}

export async function getReport(id: string): Promise<ReportRecord | undefined> {
  return db.reports.get(id)
}

export async function putReport(report: ReportRecord): Promise<void> {
  await db.reports.put(toPlain(report))
}
