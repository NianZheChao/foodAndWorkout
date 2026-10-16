/**
 * 提醒的本地判定（T4.5 / M11 FR-1101 / FR-1104 / FR-1105）。
 *
 * 只保留两种机制，都不依赖后端（TD-09 / OQ-8，**不做 Web Push、不做 .ics 导出**）：
 * 1. **应用内提醒**：打开应用时看「今天还没完成的事」—— `pendingReminders`；
 * 2. **本地通知**：应用打开时到了设定时间才响 —— `dueReminders`（能不能响还要问一次浏览器权限，
 *    见 `application/notify.ts`）。
 *
 * 两条克制规则（FR-1105）：**到了设定时间才提醒**（不是一整天催）、**同一事项一天内不重复催**
 * （「今天已经通知过」由调用方按天记录，本模块只管判定）。
 *
 * 这里全是纯函数：判断需要的事实（星期、月末、今天有没有称重…）由调用方查库后传进来。
 */

import dayjs from 'dayjs'
import type { ReminderSetting } from './types'

export const REMINDER_IDS = {
  morningWeight: 'morning-weight',
  eveningWeight: 'evening-weight',
  intake: 'intake',
  weeklyReport: 'weekly-report',
  monthlyReport: 'monthly-report'
} as const

/** 出厂默认的五项（FR-1101）。用户改过的时间 / 开关不会被这里覆盖。 */
export const REMINDER_DEFAULTS: readonly ReminderSetting[] = [
  { id: REMINDER_IDS.morningWeight, label: '晨起称重', time: '09:00', enabled: true },
  { id: REMINDER_IDS.eveningWeight, label: '睡前称重', time: '22:30', enabled: true },
  { id: REMINDER_IDS.intake, label: '当天摄入还没记完', time: '20:00', enabled: true },
  { id: REMINDER_IDS.weeklyReport, label: '周末生成周报', time: '20:00', enabled: true },
  { id: REMINDER_IDS.monthlyReport, label: '月初生成月报', time: '20:00', enabled: true }
]

/**
 * 「怎么补」的一句话（FR-1102 的入口提示）：应用内提醒与系统通知共用同一句文案，
 * 免得两边各写一套说法。
 */
export const REMINDER_HINTS: Record<string, string> = {
  [REMINDER_IDS.morningWeight]: '晨起排尿后、空腹称一次，这个数字进趋势与均线。',
  [REMINDER_IDS.eveningWeight]: '睡前称一次：它只用来算「当晚与次日晨重的差」。',
  [REMINDER_IDS.intake]: '今天一餐都还没记，一顿一顿补也行，不用一次记完。',
  [REMINDER_IDS.weeklyReport]: '这一周记完了，生成一份周报看看趋势与达标率。',
  [REMINDER_IDS.monthlyReport]: '这个月过完了，生成一份月报看看整体。'
}

export interface ReminderFacts {
  /** 判定用的那一天（本地时区 `YYYY-MM-DD`） */
  date: string
  /** 今天的星期，0 = 周日 */
  weekday: number
  /** 今天是不是「这一周的最后一天」（按 `weekStart` 算） */
  isWeekEnd: boolean
  /** 今天是不是本月最后一天 */
  isMonthEnd: boolean
  /** 当前时刻（本地时区的分钟数，0–1439） */
  minutes: number
  hasMorningWeight: boolean
  hasEveningWeight: boolean
  hasIntake: boolean
  hasWeeklyReport: boolean
  hasMonthlyReport: boolean
}

function dayFlagsOf(date: string): Pick<ReminderFacts, 'date' | 'weekday' | 'isMonthEnd'> {
  const day = dayjs(date)
  return {
    date: day.format('YYYY-MM-DD'),
    weekday: day.day(),
    isMonthEnd: day.add(1, 'day').month() !== day.month()
  }
}

export interface ReminderFactInput {
  weekStart: 1 | 7
  hasMorningWeight: boolean
  hasEveningWeight: boolean
  hasIntake: boolean
  hasWeeklyReport: boolean
  hasMonthlyReport: boolean
}

/** 把「哪一天 + 现在几点 + 今天有哪些数据」拼成判定所需的事实。 */
export function factsFor(date: string, now: Date, input: ReminderFactInput): ReminderFacts {
  const flags = dayFlagsOf(date)
  // 周的最后一天跟着设置走：周一起算 → 周日收尾；周日起算 → 周六收尾
  return {
    ...flags,
    isWeekEnd: flags.weekday === (input.weekStart === 1 ? 0 : 6),
    minutes: now.getHours() * 60 + now.getMinutes(),
    hasMorningWeight: input.hasMorningWeight,
    hasEveningWeight: input.hasEveningWeight,
    hasIntake: input.hasIntake,
    hasWeeklyReport: input.hasWeeklyReport,
    hasMonthlyReport: input.hasMonthlyReport
  }
}

/** `'22:30'` → 1350。解析不出来返回 `NaN`（那种情况下永远不到点，也就永远不响）。 */
export function minutesOfTime(time: string): number {
  const matched = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time ?? '')
  if (!matched) return Number.NaN
  const hours = Number(matched[1])
  const minutes = Number(matched[2])
  if (hours > 23 || minutes > 59) return Number.NaN
  return hours * 60 + minutes
}

/** 这一项今天是不是「还没完成」。认不出的 id 一律不算（不臆造语义）。 */
export function reminderOpen(reminder: ReminderSetting, facts: ReminderFacts): boolean {
  switch (reminder.id) {
    case REMINDER_IDS.morningWeight:
      return !facts.hasMorningWeight
    case REMINDER_IDS.eveningWeight:
      return !facts.hasEveningWeight
    case REMINDER_IDS.intake:
      return !facts.hasIntake
    case REMINDER_IDS.weeklyReport:
      return facts.isWeekEnd && !facts.hasWeeklyReport
    case REMINDER_IDS.monthlyReport:
      return facts.isMonthEnd && !facts.hasMonthlyReport
    default:
      return false
  }
}

/** 应用内提醒：今天还没完成、且用户没关掉的那些（不看时间点，因为它只在打开应用时出现）。 */
export function pendingReminders(
  reminders: readonly ReminderSetting[],
  facts: ReminderFacts
): ReminderSetting[] {
  return reminders.filter((reminder) => reminder.enabled && reminderOpen(reminder, facts))
}

/** 本地通知：还没完成，且已经过了设定时间。 */
export function dueReminders(
  reminders: readonly ReminderSetting[],
  facts: ReminderFacts
): ReminderSetting[] {
  return pendingReminders(reminders, facts).filter(
    (reminder) => facts.minutes >= minutesOfTime(reminder.time)
  )
}

/**
 * 按 id 补齐默认项：用户改过的时间 / 开关原样保留，库里没见过的默认项加进来。
 *
 * 为什么不直接「库里为空就用默认值」：老用户的 `settings.reminders` 是 T4.5 之前写下的，
 * 里面没有「当天摄入还没记完」这一项 —— 不补的话它永远不会提醒。
 */
export function mergeReminders(stored: readonly ReminderSetting[]): ReminderSetting[] {
  const byId = new Map(stored.map((row) => [row.id, row]))
  const merged = REMINDER_DEFAULTS.map((fallback) => {
    const row = byId.get(fallback.id)
    return row ? { ...fallback, ...row } : { ...fallback }
  })
  // 用户自己加的（导入的包里可能有）留在后面，不丢
  for (const row of stored) {
    if (!REMINDER_DEFAULTS.some((fallback) => fallback.id === row.id)) merged.push({ ...row })
  }
  return merged
}

/** 未知 id 也要有话说（例如导入的包里带了别的提醒项）。 */
export function reminderHint(id: string): string {
  return REMINDER_HINTS[id] ?? '打开应用补上这一项。'
}

/**
 * 每项提醒「去哪儿补」（FR-1102）：应用内提醒卡片上点一下就能落到对的地方。
 * 认不出的 id 回今日页 —— 与其点不动，不如给一条总能走的路。
 */
export const REMINDER_TARGETS: Record<string, string> = {
  [REMINDER_IDS.morningWeight]: '/log/body',
  [REMINDER_IDS.eveningWeight]: '/log/body',
  [REMINDER_IDS.intake]: '/log/diet',
  [REMINDER_IDS.weeklyReport]: '/reports',
  [REMINDER_IDS.monthlyReport]: '/reports'
}

export function reminderTarget(id: string): string {
  return REMINDER_TARGETS[id] ?? '/today'
}
