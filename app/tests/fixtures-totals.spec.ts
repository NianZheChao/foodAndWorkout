// @vitest-environment node
/**
 * 对拍：`python scripts/nutrition.py totals 2026-10-13`（docs/pwa-design.md §5.3 T1.1）。
 *
 * 期望值由 `npm run expected` 生成；期望文件是脚本的显示输出，
 * 因此容差取 TEXT_TOLERANCE（见 tests/helpers/fixtures.ts）。
 */

import { describe, expect, it } from 'vitest'
import { sumFacts } from '@/domain/nutrition'
import { buildHints, buildSummaryRows } from '@/domain/targets'
import {
  cellOf,
  expectClose,
  expectedBullets,
  expectedTable,
  loadRecordFixtures,
  loadTargetsFixture,
  numberOf,
  recordFor
} from './helpers/fixtures'

const targets = loadTargetsFixture()
const records = loadRecordFixtures()
const day = recordFor(records, '2026-10-13')
const intake = sumFacts(day.intake.map((row) => row.facts))

const EXPECTED_FILE = 'expected-totals.txt'
const table = expectedTable(EXPECTED_FILE, ['摄入', '目标', '占比'])
const rows = buildSummaryRows(intake, targets)

describe('对拍 totals：汇总六项与占比', () => {
  it('解析出的记录与脚本读到的一致（10-13 有 2 条摄入）', () => {
    expect(day.hasIntakeTable).toBe(true)
    expect(day.intake).toHaveLength(2)
  })

  it('目标取自 targets.md 的 front-matter', () => {
    expect(targets.kcalTarget).toBe(2420)
    expect(targets.proteinTargetG).toBe(176)
    expect(targets.sodiumMaxMg).toBe(2300)
  })

  it('表格有 6 行且顺序、标签与脚本一致', () => {
    expect(table.rows).toHaveLength(6)
    expect(rows.map((row) => row.label)).toEqual(table.rows.map((row) => cellOf(table, row, '项目')))
  })

  it.each([0, 1, 2, 3, 4, 5])('第 %i 行的摄入 / 目标 / 差额 / 占比与脚本一致', (index) => {
    const actual = rows[index]
    const expected = table.rows[index]
    const label = actual.label
    expectClose(actual.intake, numberOf(table, expected, '摄入'), `${label}.摄入`)
    expectClose(actual.target, numberOf(table, expected, '目标'), `${label}.目标`)
    expectClose(actual.diff, numberOf(table, expected, '差额'), `${label}.差额`)
    const percent = Number(cellOf(table, expected, '占比').replace('%', ''))
    expect(Math.round(actual.ratio * 100), `${label}.占比`).toBe(percent)
  })

  it('钠是上限口径：目标是上限值，占比 = 摄入 / 上限', () => {
    const sodium = rows[5]
    expect(sodium.target).toBe(2300)
    expectClose(sodium.ratio, sodium.intake / sodium.target, '钠占比')
  })
})

describe('对拍 totals：缺口提示文案', () => {
  it('提示条数与逐字文案与脚本一致', () => {
    expect(buildHints(intake, targets)).toEqual(expectedBullets(EXPECTED_FILE))
  })

  it('体重与训练状态与记录文件一致', () => {
    expect(day.weightAmKg).toBe(85)
    expect(day.weightPmKg).toBeUndefined()
    expect(day.training).toHaveLength(0)
  })
})
