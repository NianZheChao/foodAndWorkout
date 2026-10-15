/** 日期工具。全部用本地时区的 `YYYY-MM-DD` 字符串，避免 UTC 偏移把记录挪到前一天。 */

import dayjs from 'dayjs'

export const WEEKDAY_CN = '日一二三四五六'

export function todayIso(): string {
  return dayjs().format('YYYY-MM-DD')
}

export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayjs(value, 'YYYY-MM-DD', true).isValid()
}

export function addDays(date: string, days: number): string {
  return dayjs(date).add(days, 'day').format('YYYY-MM-DD')
}

export function weekdayCn(date: string): string {
  return WEEKDAY_CN[dayjs(date).day()]
}

/** 展示用：`10月13日 周二`。 */
export function formatDateCn(date: string): string {
  return `${dayjs(date).month() + 1}月${dayjs(date).date()}日 周${weekdayCn(date)}`
}

export function daysBetween(start: string, end: string): number {
  return dayjs(end).diff(dayjs(start), 'day')
}

/** 最近 n 天的日期（含 end 当天），升序。 */
export function recentDates(end: string, days: number): string[] {
  return Array.from({ length: days }, (_, index) => addDays(end, index - days + 1))
}

