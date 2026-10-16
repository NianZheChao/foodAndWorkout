/**
 * 提醒的应用层（T4.5 / FR-1101）：查库凑出判定所需的「事实」，判定本身在 `domain/reminders.ts`。
 *
 * 应用内提醒与本地通知共用这一份事实：两边判断口径必须一致，否则会出现
 * 「卡片上写着还没称重、通知却说你已经称过了」这种自相矛盾。
 */

import { getDay } from '@/data/repositories/days'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listReports } from '@/data/repositories/reports'
import { getSettings } from '@/data/repositories/settings'
import { todayIso } from '@/app/date'
import { periodOf } from '@/domain/reportDigest'
import {
  dueReminders,
  factsFor,
  mergeReminders,
  pendingReminders,
  type ReminderFacts
} from '@/domain/reminders'
import type { ReminderSetting } from '@/domain/types'

export interface ReminderState {
  date: string
  facts: ReminderFacts
  /** 全部提醒项（含用户关掉的） */
  all: ReminderSetting[]
  /** 应用内提醒：今天还没完成的事（不看时间点） */
  pending: ReminderSetting[]
  /** 本地通知：还没完成且已过设定时间 */
  due: ReminderSetting[]
}

export async function buildReminderState(
  date: string = todayIso(),
  now: Date = new Date()
): Promise<ReminderState> {
  const [settings, day, intake, reports] = await Promise.all([
    getSettings(),
    getDay(date),
    listIntakeByDate(date),
    listReports()
  ])

  // 报告口径固定按周一起算（§6.4），与 `weekStart` 无关；`weekStart` 只决定「哪一天算周末」
  const weekly = periodOf('weekly', date)
  const monthly = periodOf('monthly', date)
  const facts = factsFor(date, now, {
    weekStart: settings.weekStart,
    hasMorningWeight: day?.weightAmKg !== undefined,
    hasEveningWeight: day?.weightPmKg !== undefined,
    hasIntake: intake.length > 0,
    hasWeeklyReport: reports.some((row) => row.type === 'weekly' && row.periodStart === weekly.start),
    hasMonthlyReport: reports.some((row) => row.type === 'monthly' && row.periodStart === monthly.start)
  })

  const all = mergeReminders(settings.reminders ?? [])
  return {
    date,
    facts,
    all,
    pending: pendingReminders(all, facts),
    due: dueReminders(all, facts)
  }
}
