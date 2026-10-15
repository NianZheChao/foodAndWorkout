/**
 * 对拍测试的公共工具。
 *
 * 期望值来自 `scripts/nutrition.py`（docs/pwa-design.md §5.3），因此期望值是
 * **脚本的显示输出**，已经按 1 位小数四舍五入过。比较容差取 0.051 ——
 * 设计给的 0.05 加上「显示舍入的半个最低位」，再多就说明口径真的漂了。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseRecord,
  parseTables,
  pickTable,
  parseFrontMatter,
  numFromCell,
  normalizeWorkoutType,
  type ParsedRecord,
  type ParsedTable
} from '@/io/markdown/record'
import { parseSetVolume } from '@/domain/training'
import type { IntakeEntry, NutritionFacts, TargetsRecord, WorkoutEntry, WorkoutSet } from '@/domain/types'

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

export const TEXT_TOLERANCE = 0.051

export function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
}

export const FIXTURE_RECORD_DATES = ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']

export function loadRecordFixtures(): ParsedRecord[] {
  return FIXTURE_RECORD_DATES.map((date) => parseRecord(readFixture(`records/${date}.md`), date))
}

export function recordFor(records: readonly ParsedRecord[], date: string): ParsedRecord {
  const found = records.find((record) => record.date === date)
  if (!found) throw new Error(`fixture 缺少 ${date}`)
  return found
}

/** 断言数值接近期望值（期望值来自脚本的显示文本，见文件头注释）。 */
export function expectClose(actual: number, expected: number | undefined, label: string): void {
  if (expected === undefined) throw new Error(`${label}: 期望值解析失败`)
  if (Math.abs(actual - expected) > TEXT_TOLERANCE) {
    throw new Error(`${label}: 实测 ${actual}，期望 ${expected}`)
  }
}

/** 期望值为 `-` 时必须同为空；否则按容差比较。 */
export function expectMaybeClose(
  actual: number | undefined,
  expected: number | undefined,
  label: string
): void {
  if (expected === undefined) {
    if (actual !== undefined) throw new Error(`${label}: 期望为空，实测 ${actual}`)
    return
  }
  if (actual === undefined) throw new Error(`${label}: 期望 ${expected}，实测为空`)
  expectClose(actual, expected, label)
}

/** 抽出一行文本里的全部数字，用于逐项比对脚本的叙述行。 */
export function numbersIn(line: string): number[] {
  return (line.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/** 取期望文件里以某前缀开头的 `- ` 行。 */
export function expectedLineContaining(name: string, prefix: string): string {
  const found = readFixture(name)
    .split('\n')
    .find((line) => line.startsWith(prefix))
  if (!found) throw new Error(`${name}: 找不到以「${prefix}」开头的行`)
  return found
}

/** 从期望文件里取第一张同时含全部关键词的表。 */
export function expectedTable(name: string, keywords: string[]): ParsedTable {
  const table = pickTable(parseTables(readFixture(name)), keywords)
  if (!table) throw new Error(`${name}: 找不到表 ${keywords.join(',')}`)
  return table
}

/** 按表头关键词取某行的单元格文本。 */
export function cellOf(table: ParsedTable, row: string[], keyword: string): string {
  const index = table.headers.findIndex((header) => header.includes(keyword))
  return index >= 0 && index < row.length ? row[index] : ''
}

export function numberOf(table: ParsedTable, row: string[], keyword: string): number | undefined {
  return numFromCell(cellOf(table, row, keyword))
}

/** 期望文件里的 `- ` 提示行（用于比对缺口提示文案）。 */
export function expectedBullets(name: string): string[] {
  return readFixture(name)
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
}

export function loadTargetsFixture(): Pick<
  TargetsRecord,
  'kcalTarget' | 'proteinTargetG' | 'fatTargetG' | 'carbTargetG' | 'fiberTargetG' | 'sodiumMaxMg'
> {
  const { front } = parseFrontMatter(readFixture('targets.md'))
  return {
    kcalTarget: numFromCell(front.kcal_target) ?? 0,
    proteinTargetG: numFromCell(front.protein_target_g) ?? 0,
    fatTargetG: numFromCell(front.fat_target_g) ?? 0,
    carbTargetG: numFromCell(front.carb_target_g) ?? 0,
    fiberTargetG: numFromCell(front.fiber_target_g) ?? 0,
    sodiumMaxMg: numFromCell(front.sodium_max_mg) ?? 0
  }
}

export function loadProfileFixture(): ReturnType<typeof parseFrontMatter>['front'] {
  return parseFrontMatter(readFixture('profile.md')).front
}

/** 解析后的摄入行 → 领域对象（`computed` 用文件里已算好的数值，与脚本一致）。 */
export function toIntakeEntries(record: ParsedRecord): IntakeEntry[] {
  return record.intake.map((row, index) => ({
    id: `${record.date}-${index}`,
    date: record.date,
    meal: (row.meal as IntakeEntry['meal']) || '加餐',
    dish: row.dish,
    foodId: row.foodName,
    foodSnapshot: { name: row.foodName, unit: '100g', ...row.facts },
    amount: { qty: 0, unit: row.portion },
    computed: row.facts,
    note: row.note
  }))
}

/** 解析后的训练行 → 领域对象；组次结构由 `组x次x重量` 文本还原。 */
export function toWorkoutEntries(record: ParsedRecord): WorkoutEntry[] {
  return record.training.map((row, index) => {
    const parsed = parseSetVolume(row.volumeRaw)
    let sets: WorkoutSet[] | undefined
    if (parsed) {
      sets = Array.from({ length: parsed.sets }, () => ({
        reps: parsed.reps,
        weightKg: parsed.weightKg,
        bodyweight: parsed.weightKg === undefined
      }))
    }
    return {
      id: `${record.date}-w${index}`,
      date: record.date,
      time: row.time,
      type: normalizeWorkoutType(row.type),
      minutes: row.minutes,
      rpe: row.rpe,
      muscles: row.muscles,
      exercise: row.exercise,
      sets,
      volumeRaw: row.volumeRaw,
      volumeLoad: parsed?.volumeLoad,
      estimatedKcal: row.estimatedKcal
    }
  })
}

/** 只取六项营养数值，便于比较。 */
export function factsOf(list: readonly NutritionFacts[]): NutritionFacts {
  return list.reduce<NutritionFacts>(
    (total, item) => ({
      kcal: total.kcal + item.kcal,
      proteinG: total.proteinG + item.proteinG,
      fatG: total.fatG + item.fatG,
      carbG: total.carbG + item.carbG,
      fiberG: total.fiberG + item.fiberG,
      sodiumMg: total.sodiumMg + item.sodiumMg
    }),
    { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 }
  )
}

export const FIXTURE_DIR_PATH = FIXTURE_DIR
