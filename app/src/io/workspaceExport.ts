/**
 * 工作区文本导出（T4.2 / docs/pwa-design.md §7.2，FR-1204 / FR-1206）。
 *
 * 读库 → 交给 `io/markdown/export.ts` 渲染 → 打包成**一个** Markdown 文本供下载 / 复制。
 * 为什么不是 zip：与 §7.1 同一条理由 —— iOS 上分享与查看都更省事，用户拿文本编辑器就能读。
 * 包内每个文件前一行 `<!-- thin-muscle-workspace: <相对路径> -->`，`splitWorkspaceBundle`
 * 是它的逆运算（导出与回放的往返一致由 `tests/workspace-export.spec.ts` 钉住）。
 *
 * 验收方式写在 §7.2：把这批文件放进工作区后跑 `python scripts/nutrition.py check --all`
 * 必须无错误（`tests/workspace-script.spec.ts` 真的去跑那个脚本）。
 */

import { todayIso } from '@/app/date'
import { db, SINGLETON_KEY } from '@/data/db'
import { MEALS } from '@/io/markdown/record'
import { renderFoodsCsv, renderProfileFile, renderRecordFile, renderTargetsFile } from '@/io/markdown/export'
import type { TargetValues } from '@/domain/targets'
import type { IntakeEntry, Meal, WorkoutEntry } from '@/domain/types'

export interface WorkspaceFile {
  /** 工作区里的相对路径，如 `records/2026-10-13.md` */
  path: string
  text: string
}

export const BUNDLE_MARKER = 'thin-muscle-workspace'

function mealIndex(meal: string): number {
  const index = MEALS.indexOf(meal as Meal)
  return index < 0 ? MEALS.length : index
}

/**
 * 行序按**内容**排，不按主键：`id` 里虽然有创建时间戳，但同毫秒内落库的两条
 * 只能靠随机后缀分先后，导出会随机抖动。摄入按「餐次 → 菜品 → 食材」、训练按
 * 「时间 → 动作」，同一份数据每次导出都是同一个文件（便于用户自己 diff）。
 */
function orderIntake(entries: readonly IntakeEntry[]): IntakeEntry[] {
  return [...entries].sort(
    (a, b) =>
      mealIndex(a.meal) - mealIndex(b.meal) ||
      (a.dish ?? '').localeCompare(b.dish ?? '', 'zh-Hans-CN') ||
      (a.foodSnapshot?.name ?? '').localeCompare(b.foodSnapshot?.name ?? '', 'zh-Hans-CN')
  )
}

function orderWorkout(entries: readonly WorkoutEntry[]): WorkoutEntry[] {
  return [...entries].sort(
    (a, b) =>
      (a.time ?? '').localeCompare(b.time ?? '') ||
      (a.exercise ?? '').localeCompare(b.exercise ?? '', 'zh-Hans-CN')
  )
}

function markerPattern(): RegExp {
  return new RegExp(`<!-- ${BUNDLE_MARKER}: (.+?) -->\\n`, 'g')
}

/**
 * 组装全部工作区文件。
 *
 * 日期取 `days` / `intake` / `workout` 三张表的并集：只记了一餐（还没建 `days` 行）或
 * 只建了空的一天（还没记任何东西）都不该在导出里凭空消失。
 */
export async function buildWorkspaceExport(): Promise<WorkspaceFile[]> {
  const [days, intake, workout, foods, profile, targets] = await Promise.all([
    db.days.toArray(),
    db.intake.toArray(),
    db.workout.toArray(),
    db.foods.toArray(),
    db.profile.get(SINGLETON_KEY),
    db.targets.get(SINGLETON_KEY)
  ])

  const dates = new Set<string>()
  for (const day of days) dates.add(day.date)
  for (const entry of intake) dates.add(entry.date)
  for (const entry of workout) dates.add(entry.date)

  const byDate = new Map(days.map((day) => [day.date, day]))
  // 未校准（没有 targets 行）时按 0 处理：`renderRecordFile` 与脚本一样把 0 当成「没有目标」，
  // 汇总块只写摄入、不瞎编差额。
  const targetValues: TargetValues = {
    kcalTarget: targets?.kcalTarget ?? 0,
    proteinTargetG: targets?.proteinTargetG ?? 0,
    fatTargetG: targets?.fatTargetG ?? 0,
    carbTargetG: targets?.carbTargetG ?? 0,
    fiberTargetG: targets?.fiberTargetG ?? 0,
    sodiumMaxMg: targets?.sodiumMaxMg ?? 0
  }

  const files: WorkspaceFile[] = []
  for (const date of [...dates].sort()) {
    const day = byDate.get(date)
    files.push({
      path: `records/${date}.md`,
      text: renderRecordFile({
        date,
        weekday: day?.weekday,
        weightAmKg: day?.weightAmKg,
        weightPmKg: day?.weightPmKg,
        sleepHours: day?.sleepHours,
        energy: day?.energy,
        soreness: day?.soreness,
        note: day?.note,
        todos: day?.todos,
        intake: orderIntake(intake.filter((entry) => entry.date === date)),
        workout: orderWorkout(workout.filter((entry) => entry.date === date)),
        targets: targetValues
      })
    })
  }
  files.push({ path: 'data/foods.csv', text: renderFoodsCsv(foods) })
  if (profile) files.push({ path: 'profile.md', text: renderProfileFile(profile) })
  if (targets) files.push({ path: 'targets.md', text: renderTargetsFile(targets) })
  return files
}

/** 拼成一个可下载 / 可复制的文本包（每个文件前面只有一行路径标记，别无他物）。 */
export function bundleWorkspaceFiles(files: readonly WorkspaceFile[]): string {
  return files.map((file) => `<!-- ${BUNDLE_MARKER}: ${file.path} -->\n${file.text}`).join('')
}

/** `bundleWorkspaceFiles` 的逆运算；文本原样返回（含末尾换行）。 */
export function splitWorkspaceBundle(text: string): WorkspaceFile[] {
  const matches = [...text.matchAll(markerPattern())]
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length
    return { path: match[1], text: text.slice(start, end) }
  })
}

export function workspaceExportFileName(date = todayIso()): string {
  return `薄肌计划-工作区-${date}.md`
}

export interface WorkspaceExportStats {
  /** 记录天数 */
  records: number
  /** 食物条数 */
  foods: number
  /** 文本包总行数，给用户一个"东西有多少"的直观量 */
  lines: number
}

export function workspaceExportStats(files: readonly WorkspaceFile[]): WorkspaceExportStats {
  const csv = files.find((file) => file.path === 'data/foods.csv')
  return {
    records: files.filter((file) => file.path.startsWith('records/')).length,
    foods: csv ? csv.text.trim().split('\n').length - 1 : 0,
    lines: bundleWorkspaceFiles(files).split('\n').length
  }
}
