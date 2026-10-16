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

/**
 * 删掉一份报告（FR-700 / FR-710）。
 *
 * 报告是**本地产出的一份视图**，不是原始数据：原始记录（饮食 / 训练 / 体重）都在各自的表里，
 * 删掉它不影响任何一条记录，需要时重新生成即可。所以这里没有引用保护，只有界面上的二次确认。
 */
export async function removeReport(id: string): Promise<void> {
  await db.reports.delete(id)
}
