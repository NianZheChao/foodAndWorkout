// @vitest-environment node
/**
 * 报告生成用例（T3.2 / §6.4）。
 *
 * 守住四条：数值区永远来自本地（模型失败也照样有）、三道闸门生效、
 * 重新生成不动旧版本、人工编辑只动文字并留痕。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { generateReport, saveEditedContent } from '@/application/report'
import { db } from '@/data/db'
import { addIntake } from '@/data/repositories/intake'
import { updateDay } from '@/data/repositories/days'
import { getReport, listReports } from '@/data/repositories/reports'
import { putTargets } from '@/data/repositories/targets'
import { chatOk, stubFetch } from './helpers/llm'
import type { ModelConfigRecord } from '@/domain/types'

const END = '2026-10-15'

function config(patch: Partial<ModelConfigRecord> = {}): ModelConfigRecord {
  return {
    id: 'current',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    timeoutMs: 1000,
    enabled: true,
    updatedAt: Date.now(),
    ...patch
  }
}

const run = { config: config(), sleep: async () => undefined, retryDelayMs: 0, skipLog: true }

function reportJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: '本期一句话。',
    training: { assessment: '未达标', notes: [] },
    diet: { assessment: '基本达标', notes: [] },
    recovery: { notes: [] },
    findings: [{ kind: 'fact', text: '日均摄入 1600 kcal。' }],
    issues: [],
    actions: ['继续记录'],
    calibration: { recommended: false, deltaKcal: 0, rationale: '' },
    disclaimer: '仅供参考。',
    ...patch
  })
}

async function seedDay(date: string, weightKg: number, kcal?: number): Promise<void> {
  await updateDay(date, { weightAmKg: weightKg })
  if (kcal === undefined) return
  await addIntake({
    date,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: {
      name: '测试食材',
      unit: '100g',
      kcal,
      proteinG: 80,
      fatG: 40,
      carbG: 100,
      fiberG: 10,
      sodiumMg: 1000
    },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal, proteinG: 80, fatG: 40, carbG: 100, fiberG: 10, sodiumMg: 1000 }
  })
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await putTargets({
    tdeeKcal: 2633,
    kcalTarget: 2100,
    proteinTargetG: 140,
    fatTargetG: 70,
    carbTargetG: 270,
    fiberTargetG: 30,
    sodiumMaxMg: 2000,
    weeklyTrainingDays: 3,
    weeklySetsPerMuscle: 10,
    targetWeightKg: 65,
    targetRateKgPerWeek: -0.39,
    reviewCadence: 'weekly'
  })
})

describe('生成报告', () => {
  it('数值区来自本地聚合，文字区来自模型，并记下模型与契约版本', async () => {
    await seedDay('2026-10-12', 71, 1800)
    await seedDay('2026-10-13', 70.6, 1600)
    await seedDay('2026-10-14', 70.2)
    await seedDay('2026-10-15', 70)

    const { fetchImpl, calls } = stubFetch([chatOk(reportJson())])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(true)
    const report = outcome.report
    if (!report?.content) throw new Error('没有生成内容')

    // 数值区：本地算的，且和趋势口径一致（2 天有记录、日均 1700 kcal）
    expect(report.digest.period.label).toBe('2026-W42')
    expect(report.digest.coverage.daysWithIntake).toBe(2)
    expect(report.digest.intake.avgKcal).toBeCloseTo(1700, 1)
    expect(report.digest.training.days).toBe(0)
    expect(report.status).toBe('ready')
    expect(report.model).toBe('test-model')
    expect(report.taskVersion).toBe(1)
    expect(report.editedByUser).toBe(false)
    // 请求体里只有摘要，没有原始记录
    expect(JSON.stringify(calls[0].body)).not.toContain('测试食材')
  })

  it('模型失败也留下数值区：状态 pending，可以稍后重新生成', async () => {
    await seedDay('2026-10-12', 71, 1800)
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.retriable).toBe(true)
    const saved = outcome.report
    expect(saved?.status).toBe('pending')
    expect(saved?.content).toBeNull()
    expect(saved?.digest.intake.avgKcal).toBe(1800)
    expect((await listReports()).length).toBe(1)
  })

  it('样本不足时提示覆盖率，并把校准建议降级（FR-707 / FR-708）', async () => {
    await seedDay('2026-10-12', 71, 1800)
    const { fetchImpl } = stubFetch([
      chatOk(reportJson({ calibration: { recommended: true, deltaKcal: -100, rationale: '实测偏高' } }))
    ])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.notices.join()).toContain('样本不足')
    expect(outcome.report?.content?.calibration.recommended).toBe(false)
    expect(outcome.notices.join()).toContain('不给校准建议')
  })

  it('幅度超限的校准建议降级并说明（FR-904）', async () => {
    await seedDay('2026-10-12', 71, 1800)
    await seedDay('2026-10-13', 70.6, 1600)
    const { fetchImpl } = stubFetch([
      chatOk(reportJson({ calibration: { recommended: true, deltaKcal: -400, rationale: '实测偏高' } }))
    ])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.notices.join()).toContain('±150 kcal')
    expect(outcome.report?.content?.calibration.recommended).toBe(false)
  })

  it('编造的数字被标出来存进报告（DR-37）', async () => {
    await seedDay('2026-10-12', 71, 1800)
    await seedDay('2026-10-13', 70.6, 1600)
    const { fetchImpl } = stubFetch([
      chatOk(
        reportJson({
          summary: '本期平均每天多吃了 380 kcal。',
          findings: [
            { kind: 'fact', text: '日均摄入 1700 kcal。' },
            { kind: 'inference', text: '照这个速度 6 周后到 78 kg。' }
          ]
        })
      )
    ])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })
    expect(outcome.report?.flaggedNumbers).toEqual(['380', '78'])
  })

  it('缺少 kind 的不合规输出会重试一次，仍失败就不落库', async () => {
    await seedDay('2026-10-12', 71, 1800)
    const bad = JSON.stringify({
      summary: 'x',
      training: { assessment: 'x', notes: [] },
      diet: { assessment: 'x', notes: [] },
      recovery: { notes: [] },
      findings: [{ text: '没有 kind' }],
      issues: [],
      actions: [],
      calibration: { recommended: false, deltaKcal: 0, rationale: '' },
      disclaimer: 'x'
    })
    const { fetchImpl, calls } = stubFetch([chatOk(bad), chatOk(bad)])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(2)
    expect(outcome.report?.status).toBe('pending')
  })
})

describe('报告版本与人工编辑（FR-710 / T3.3）', () => {
  async function generateOnce(): Promise<string> {
    await seedDay('2026-10-12', 71, 1800)
    await seedDay('2026-10-13', 70.6, 1600)
    const { fetchImpl } = stubFetch([chatOk(reportJson())])
    const outcome = await generateReport({ type: 'weekly', endDate: END }, { ...run, deps: { fetchImpl } })
    if (!outcome.report) throw new Error('没有生成报告')
    return outcome.report.id
  }

  it('重新生成新建一条记录，旧版本原样留着', async () => {
    const first = await generateOnce()
    const second = await generateOnce()
    const rows = await listReports('weekly')
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first, second]))
    expect(await getReport(first)).toBeDefined()
  })

  it('人工编辑只改文字区并留痕，数值区不动', async () => {
    const id = await generateOnce()
    const before = await getReport(id)
    if (!before?.content) throw new Error('没有文字区可编辑')
    const edited = await saveEditedContent(id, { ...before.content, summary: '我自己改过的一句话。' })

    expect(edited?.content?.summary).toBe('我自己改过的一句话。')
    expect(edited?.editedByUser).toBe(true)
    expect(edited?.digest).toEqual(before?.digest)
    expect(edited?.status).toBe('ready')
  })
})
