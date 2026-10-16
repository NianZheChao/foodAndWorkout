// @vitest-environment node
/**
 * 诊断信息导出（T4.6 / design §10.2 / FR-1608）。
 *
 * 这个文件的**唯一意义**是「能安全地发给别人」，所以用例的重点不是字段齐全，而是三条禁令：
 * **不出现 token**、**不出现记录内容**（饮食名 / 体重都不行，只留条数）、**最多 20 条错误**。
 * 另外钉住两处来源（队列的失败原因 + 调用日志的错误分类）与文件名 / 序列化格式。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { APP_VERSION } from '@/app/version'
import { db, SCHEMA_VERSION } from '@/data/db'
import { addIntake } from '@/data/repositories/intake'
import { logLlmCall } from '@/data/repositories/llmLogs'
import { saveModelConfig } from '@/data/repositories/modelConfig'
import { enqueue, markOp } from '@/data/repositories/pendingOps'
import { updateDay } from '@/data/repositories/days'
import { EXPORT_FORMAT_VERSION } from '@/io/exportPackage'
import {
  DIAGNOSTIC_ERROR_LIMIT,
  DIAGNOSTICS_FORMAT_VERSION,
  buildDiagnostics,
  diagnosticsFileName,
  serializeDiagnostics
} from '@/io/diagnostics'

const SECRET = 'sk-super-secret-value'
const PRIVATE_FOOD = '很隐私的食材'

async function seedRecord(): Promise<void> {
  await updateDay('2026-10-15', { weightAmKg: 75.1 })
  await addIntake({
    date: '2026-10-15',
    meal: '午餐',
    dish: PRIVATE_FOOD,
    foodId: PRIVATE_FOOD,
    foodSnapshot: {
      name: PRIVATE_FOOD,
      unit: '100g',
      kcal: 120,
      proteinG: 20,
      fatG: 3,
      carbG: 5,
      fiberG: 1,
      sodiumMg: 60
    },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 }
  })
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('诊断信息导出', () => {
  it('装版本 / 环境 / 条数 / 模型地址，但不装 token 与记录内容', async () => {
    await saveModelConfig({
      baseUrl: 'https://api.example.com/v1',
      apiKey: SECRET,
      model: 'gpt-x',
      enabled: true,
      supportsJsonResponse: true
    })
    await seedRecord()

    const report = await buildDiagnostics(0)
    const text = serializeDiagnostics(report)

    expect(report.formatVersion).toBe(DIAGNOSTICS_FORMAT_VERSION)
    expect(report.app).toEqual({
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportFormatVersion: EXPORT_FORMAT_VERSION
    })
    expect(report.generatedAt).toBe(new Date(0).toISOString())
    expect(report.model).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-x',
      enabled: true,
      supportsJsonResponse: true
    })
    // 只有条数：1 天记录、1 条饮食 —— 内容一个字都不进这个文件
    expect(report.counts.days).toBe(1)
    expect(report.counts.intake).toBe(1)
    expect(report.counts.foods).toBe(0)

    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('apiKey')
    expect(text).not.toContain(PRIVATE_FOOD)
    expect(text).not.toContain('75.1')
    // 序列化就是给人看 / 贴的：缩进 JSON，且能原样解析回来
    expect(text).toContain('\n  "formatVersion"')
    expect(JSON.parse(text)).toEqual(report)
  })

  it('空库也能导出（没配模型时说 configured=false，存储信息可缺省）', async () => {
    const report = await buildDiagnostics()
    // 出厂默认就是「开关是开的，但没有任何凭据」：所以 configured 是 false（缺 baseUrl / key / model）
    expect(report.model).toMatchObject({ configured: false, baseUrl: '', model: '' })
    expect(report.llm.calls).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.counts.days).toBe(0)
  })

  it('错误从队列与调用日志两处汇总，最多留 20 条', async () => {
    for (let index = 0; index < 15; index += 1) {
      const id = await enqueue('food.resolve', `食材${index}`)
      await markOp(id, { status: 'needs-attention', lastError: `队列原因${index}` })
    }
    for (let index = 0; index < 10; index += 1) {
      await logLlmCall(
        {
          taskId: 'food.resolve',
          taskVersion: 1,
          model: 'm',
          durationMs: 1,
          promptTokensEst: 2,
          completionTokensEst: 3,
          status: 'error',
          errorKind: 'http_500'
        },
        1000 + index
      )
    }

    const report = await buildDiagnostics()
    expect(report.errors).toHaveLength(DIAGNOSTIC_ERROR_LIMIT)
    expect(report.errors.some((item) => item.source === 'queue')).toBe(true)
    expect(report.errors.some((item) => item.source === 'llm')).toBe(true)
    // 新的在前
    expect(report.errors[0].at).toBeGreaterThanOrEqual(report.errors[1].at)
    expect(report.llm).toMatchObject({ calls: 10, errors: 10, promptTokensEst: 20, completionTokensEst: 30 })
    expect(report.counts.llmLogs).toBe(10)
    expect(report.counts.pendingOps).toBe(15)
  })

  it('文件名带日期', () => {
    expect(diagnosticsFileName('2026-10-16')).toBe('thin-muscle-plan-diagnostics-2026-10-16.json')
  })
})
