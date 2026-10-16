// @vitest-environment node
/**
 * 导出包（T4.1 / §7.1，FR-1204 / FR-1305）。
 *
 * 守四件事：**校验和只认规范化 JSON**（换个键序不能变）、**不含模型配置与调用日志**、
 * manifest 的条目数说得清包里有什么、应用版本与 `package.json` 不会悄悄分叉。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildExportPackage,
  canonicalJson,
  checksumOf,
  exportFileName,
  EXPORT_APP,
  EXPORT_FORMAT_VERSION,
  serializeExport
} from '@/io/exportPackage'
import { APP_VERSION } from '@/app/version'
import { db, SCHEMA_VERSION } from '@/data/db'
import { updateDay } from '@/data/repositories/days'
import { addIntake } from '@/data/repositories/intake'
import { addWorkout } from '@/data/repositories/workout'
import { putTargets } from '@/data/repositories/targets'
import { logLlmCall } from '@/data/repositories/llmLogs'
import { saveModelConfig } from '@/data/repositories/modelConfig'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

async function seed(): Promise<void> {
  await updateDay('2026-10-15', { weightAmKg: 75.1 })
  await addIntake({
    date: '2026-10-15',
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: { name: '测试食材', unit: '100g', kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 }
  })
  await addWorkout({ date: '2026-10-15', type: '力量', exercise: '杠铃划船', muscles: ['背'] })
  await putTargets({
    tdeeKcal: 2600,
    kcalTarget: 2100,
    proteinTargetG: 150,
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
}

describe('规范化 JSON 与校验和', () => {
  it('对象键顺序不影响结果（否则完好的文件会被判成「被改过」）', async () => {
    const a = { b: 1, a: [1, { d: 2, c: 3 }] }
    const b = { a: [1, { c: 3, d: 2 }], b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(await checksumOf(a)).toBe(await checksumOf(b))
    expect(await checksumOf(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('数组顺序是有意义的：顺序变了校验和必须变', async () => {
    expect(await checksumOf([1, 2])).not.toBe(await checksumOf([2, 1]))
  })
})

describe('导出包内容', () => {
  it('manifest 说明包里有什麼，且条目数与库里一致', async () => {
    await seed()
    const pkg = await buildExportPackage(new Date('2026-10-16T09:00:00+08:00'))

    expect(pkg.manifest.app).toBe(EXPORT_APP)
    expect(pkg.manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION)
    expect(pkg.manifest.schemaVersion).toBe(SCHEMA_VERSION)
    expect(pkg.manifest.exportedAt).toBe('2026-10-16T01:00:00.000Z')
    expect(pkg.manifest.appVersion).toBe(APP_VERSION)
    expect(pkg.manifest.counts).toMatchObject({ days: 1, intake: 1, workout: 1, targets: 1 })
    expect(pkg.data.days[0].date).toBe('2026-10-15')
    expect(await checksumOf(pkg.data)).toBe(pkg.checksum)
  })

  it('FR-1305：不导出模型配置与调用日志（token 不进文件）', async () => {
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-secret-token', model: 'stub' })
    await logLlmCall({
      taskId: 'coach.daily',
      taskVersion: 1,
      model: 'stub',
      durationMs: 12,
      promptTokensEst: 100,
      completionTokensEst: 50,
      status: 'ok'
    })

    const pkg = await buildExportPackage()
    const text = serializeExport(pkg)

    expect(Object.keys(pkg.data)).not.toContain('modelConfig')
    expect(Object.keys(pkg.data)).not.toContain('llmLogs')
    expect(text).not.toContain('sk-secret-token')
    expect(text).not.toContain('coach.daily')
  })

  it('导出文件名带日期，便于用户事后认领', () => {
    expect(exportFileName('2026-10-16')).toBe('薄肌计划-export-2026-10-16.json')
  })

  it('应用版本与 package.json 一致（两处不能各说各话）', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    expect(APP_VERSION).toBe(pkg.version)
  })
})
