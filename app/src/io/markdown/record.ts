/**
 * 记录文件（`records/YYYY-MM-DD.md`）的解析。
 *
 * 这是工作区格式契约的读取侧实现，解析口径与 `scripts/nutrition.py` 的
 * `parse_front_matter` / `parse_tables` / `split_sections` / `load_day` 对齐，
 * 因为对拍测试就是拿同一批文件同时喂给脚本和这里。
 *
 * 解析器只读不写；写回（导出）在 io/markdown/export.ts 里，且必须能被脚本重新读进
 * 来（docs/pwa-design.md §7.2）。
 */

import { splitMuscles } from '@/domain/training'
import type { Meal, NutritionFacts, TodoItem, WorkoutType } from '@/domain/types'

export const MEALS: Meal[] = ['早餐', '午餐', '晚餐', '加餐']
const WEEKDAY_CN = '一二三四五六日'

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/
const ROW_RE = /^\s*\|(.*)\|\s*$/
const SEP_CELL_RE = /^:?-{2,}:?$/
const NUM_RE = /-?\d+(?:\.\d+)?/
const SECTION_RE = /^##[ \t]+(.*?)[ \t]*$/

export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

/** front-matter 里的键值对，值为原始字符串（不做类型推断，与脚本一致）。 */
export type FrontMatter = Record<string, string>

export function parseFrontMatter(text: string): { front: FrontMatter; body: string } {
  const match = FRONT_MATTER_RE.exec(text)
  if (!match) return { front: {}, body: text }
  const front: FrontMatter = {}
  for (const line of match[1].split('\n')) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#') || !stripped.includes(':')) continue
    const index = stripped.indexOf(':')
    front[stripped.slice(0, index).trim()] = stripped.slice(index + 1).trim()
  }
  return { front, body: text.slice(match[0].length) }
}

/** 把文本里所有连续的 `| ... |` 行块解析成表格（首行是表头，分隔行丢弃）。 */
export function parseTables(text: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  let current: ParsedTable | undefined
  const flush = () => {
    if (current) tables.push(current)
    current = undefined
  }
  for (const line of text.split('\n')) {
    const match = ROW_RE.exec(line)
    if (match) {
      const cells = match[1].split('|').map((cell) => cell.trim())
      if (!current) {
        current = { headers: cells, rows: [] }
      } else if (cells.length && cells.every((cell) => SEP_CELL_RE.test(cell))) {
        continue
      } else {
        current.rows.push(cells)
      }
    } else {
      flush()
    }
  }
  flush()
  return tables
}

/** 按 `## 标题` 切分正文；第一个二级标题之前的内容不进 sections。 */
export function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {}
  let name: string | undefined
  let buffer: string[] = []
  for (const line of body.split('\n')) {
    const match = SECTION_RE.exec(line)
    if (match) {
      if (name !== undefined) sections[name] = buffer.join('\n')
      name = match[1].trim()
      buffer = []
    } else if (name !== undefined) {
      buffer.push(line)
    }
  }
  if (name !== undefined) sections[name] = buffer.join('\n')
  return sections
}

export function pickSection(sections: Record<string, string>, keyword: string): string {
  for (const [name, text] of Object.entries(sections)) {
    if (name.includes(keyword)) return text
  }
  return ''
}

/** 表头里同时含全部关键词的表（脚本 `pick_table`）。 */
export function pickTable(tables: ParsedTable[], keywords: string[]): ParsedTable | undefined {
  return tables.find((table) => {
    const joined = table.headers.join('')
    return keywords.every((keyword) => joined.includes(keyword))
  })
}

/** 表头里第一个含关键词的列下标（脚本 `col`）。 */
export function columnIndex(headers: string[], keyword: string): number {
  return headers.findIndex((header) => header.includes(keyword))
}

/** 从单元格里取第一个数字（脚本 `num`）；取不到返回 undefined。 */
export function numFromCell(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined
  const value = cell.trim().replace(/[,，]/g, '')
  if (!value || ['-', '—', '/', 'n/a', 'NA'].includes(value)) return undefined
  const match = NUM_RE.exec(value)
  return match ? Number(match[0]) : undefined
}

export interface ParsedIntakeRow {
  meal: string
  dish: string
  foodName: string
  portion: string
  facts: NutritionFacts
  note?: string
}

export interface ParsedTrainingRow {
  time?: string
  type?: string
  minutes?: number
  rpe?: number
  muscles: string[]
  exercise: string
  /** 原始「组x次x重量」文本 */
  volumeRaw: string
  estimatedKcal?: number
}

export interface ParsedRecord {
  date: string
  weekday: string
  weightAmKg?: number
  weightPmKg?: number
  /** 历史字段 `weight_kg`，口径不明，仅兜底 */
  legacyWeightKg?: number
  sleepHours?: number
  energy?: number
  soreness?: number
  note?: string
  todos: TodoItem[]
  intake: ParsedIntakeRow[]
  training: ParsedTrainingRow[]
  hasIntakeTable: boolean
  hasTrainingTable: boolean
}

const INTAKE_COLUMNS: [keyof NutritionFacts, string][] = [
  ['kcal', '热量'],
  ['proteinG', '蛋白'],
  ['fatG', '脂肪'],
  ['carbG', '碳水'],
  ['fiberG', '纤维'],
  ['sodiumMg', '钠']
]

function parseIntakeRows(section: string): { rows: ParsedIntakeRow[]; found: boolean } {
  const table = pickTable(parseTables(section), ['热量'])
  if (!table) return { rows: [], found: false }
  const rows = table.rows.map((row) => {
    const at = (keyword: string) => {
      const index = columnIndex(table.headers, keyword)
      return index >= 0 && index < row.length ? row[index] : ''
    }
    const facts = { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 } as NutritionFacts
    for (const [key, keyword] of INTAKE_COLUMNS) {
      facts[key] = numFromCell(at(keyword)) ?? 0
    }
    return {
      meal: at('餐'),
      dish: at('菜品') || at('做法'),
      foodName: at('食材'),
      portion: at('份量'),
      facts
    }
  })
  return { rows, found: true }
}

function parseTrainingRows(section: string): { rows: ParsedTrainingRow[]; found: boolean } {
  const table = pickTable(parseTables(section), ['时长'])
  if (!table) return { rows: [], found: false }
  const rows = table.rows.map((row) => {
    const at = (keyword: string) => {
      const index = columnIndex(table.headers, keyword)
      return index >= 0 && index < row.length ? row[index] : ''
    }
    const minutes = numFromCell(at('时长'))
    const rpe = numFromCell(at('RPE'))
    const estimatedKcal = numFromCell(at('消耗'))
    const time = at('时间').trim()
    const type = at('类型').trim()
    return {
      time: time || undefined,
      type: type || undefined,
      minutes,
      rpe,
      muscles: splitMuscles(at('肌群')),
      exercise: at('动作').trim(),
      volumeRaw: at('组') || at('重量'),
      estimatedKcal
    }
  })
  return { rows, found: true }
}

function parseTodos(section: string): TodoItem[] {
  return section
    .split('\n')
    .map((line) => /^\s*-\s*\[( |x|X)\]\s*(.*?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ done: match[1].toLowerCase() === 'x', text: match[2] }))
}

/** 解析完整的当日记录文件。 */
export function parseRecord(text: string, date: string): ParsedRecord {
  const { front, body } = parseFrontMatter(text)
  const sections = splitSections(body)
  const intake = parseIntakeRows(pickSection(sections, '摄入'))
  const training = parseTrainingRows(pickSection(sections, '训练'))
  const todoSection = pickSection(sections, '待办')
  const notesSection = pickSection(sections, '备注') || pickSection(sections, '状态')
  const weekdayIndex = WEEKDAY_CN.indexOf(front.weekday ?? '')
  return {
    date: front.date || date,
    weekday: front.weekday ?? (weekdayIndex >= 0 ? WEEKDAY_CN[weekdayIndex] : ''),
    weightAmKg: numFromCell(front.weight_am_kg),
    weightPmKg: numFromCell(front.weight_pm_kg),
    legacyWeightKg: numFromCell(front.weight_kg),
    sleepHours: numFromCell(front.sleep_hours),
    energy: numFromCell(front.energy),
    soreness: numFromCell(front.soreness),
    note: notesSection.trim() || undefined,
    todos: todoSection ? parseTodos(todoSection) : [],
    intake: intake.rows,
    training: training.rows,
    hasIntakeTable: intake.found,
    hasTrainingTable: training.found
  }
}

const WORKOUT_TYPES: WorkoutType[] = ['力量', '有氧', '球类', '拉伸', '其他']

export function normalizeWorkoutType(raw: string | undefined): WorkoutType {
  const found = WORKOUT_TYPES.find((type) => type === raw?.trim())
  return found ?? '其他'
}

