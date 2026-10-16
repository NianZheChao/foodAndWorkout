// @vitest-environment node
/**
 * 工作区文本导出（T4.2 / docs/pwa-design.md §7.2，FR-1204 / FR-1206）。
 *
 * 这一层的验收标准不是「看起来像工作区文件」，而是**能被读回来**：
 * 导出 → `parseRecord` 往返一致。至于「原脚本也能读」，由 `workspace-script.spec.ts`
 * 真的去跑 `python scripts/nutrition.py check --all`（那一条要 Python，这里不依赖）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/data/db'
import { countFoods, upsertFood } from '@/data/repositories/foods'
import { numFromCell, parseFrontMatter, parseRecord, type ParsedIntakeRow } from '@/io/markdown/record'
import {
  buildWorkspaceExport,
  bundleWorkspaceFiles,
  splitWorkspaceBundle,
  workspaceExportFileName,
  workspaceExportStats
} from '@/io/workspaceExport'
import { loadRecordFixtures } from './helpers/fixtures'
import { TRAINING_DATE, fileOf, seedFromFixtures, seedSingletons, seedTrainingDay } from './helpers/workspace'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('工作区文本导出：记录文件能被读回来', () => {
  it('fixtures 的每一天往返一致（front-matter / 备注 / 摄入数值）', async () => {
    const records = loadRecordFixtures()
    await seedFromFixtures()
    await seedSingletons()
    const files = await buildWorkspaceExport()

    for (const record of records) {
      const back = parseRecord(fileOf(files, `records/${record.date}.md`), record.date)
      expect(back.date).toBe(record.date)
      expect(back.weekday).toBe(record.weekday)
      expect(back.weightAmKg).toBe(record.weightAmKg)
      expect(back.weightPmKg).toBe(record.weightPmKg)
      expect(back.sleepHours).toBe(record.sleepHours)
      expect(back.energy).toBe(record.energy)
      expect(back.soreness).toBe(record.soreness)
      expect(back.note).toBe(record.note)
      // 摄入：行序由库决定，比较时按「餐次 + 食材 + 六项数值」排序后逐行对齐
      const line = (row: ParsedIntakeRow) =>
        `${row.meal}|${row.foodName}|${row.facts.kcal}|${row.facts.proteinG}|${row.facts.fatG}|${row.facts.carbG}|${row.facts.fiberG}|${row.facts.sodiumMg}`
      expect(back.intake.map(line).sort()).toEqual(record.intake.map(line).sort())
      expect(back.hasIntakeTable).toBe(true)
      expect(back.hasTrainingTable).toBe(true)
    }
  })

  it('训练日：组次重量原样回写，容量负荷与消耗对得上', async () => {
    await seedTrainingDay()
    await seedSingletons()
    const files = await buildWorkspaceExport()
    const back = parseRecord(fileOf(files, `records/${TRAINING_DATE}.md`), TRAINING_DATE)

    // 行序按内容排（见 `orderWorkout`），所以按动作取行、不假设第几行
    const byExercise = new Map(back.training.map((row) => [row.exercise, row]))
    expect([...byExercise.keys()].sort()).toEqual(['卧推', '卷腹', '慢跑'].sort())
    expect(byExercise.get('卧推')?.volumeRaw).toBe('4x8x60')
    expect(byExercise.get('卧推')?.muscles).toEqual(['胸', '三头'])
    expect(byExercise.get('卧推')?.rpe).toBe(8)
    expect(byExercise.get('卷腹')?.volumeRaw).toBe('3x12x自重')
    expect(byExercise.get('慢跑')?.estimatedKcal).toBe(260)
    expect(back.todos).toEqual([
      { text: '补一次晨重', done: false },
      { text: '买乳清', done: true }
    ])
    expect(back.note).toBe('测试备注\n第二行备注')

    const text = fileOf(files, `records/${TRAINING_DATE}.md`)
    expect(text).toContain('**训练**：3 个动作 · 75 分钟 · 合计 8 组 · 容量负荷 1920 kg · 自重 4 组 · 估算消耗 260 kcal · RPE 8')
    const muscleLine = text.split('\n').find((line) => line.startsWith('**涉及肌群**：'))
    expect(muscleLine?.replace('**涉及肌群**：', '').split('、').sort()).toEqual(
      ['胸 4组', '三头 4组', '腹 3组', '全身 1组'].sort()
    )
  })

  it('AUTO 区块排在「待办」段里，不会被当成备注读回来', async () => {
    await seedTrainingDay()
    await seedSingletons()
    const files = await buildWorkspaceExport()
    const text = fileOf(files, `records/${TRAINING_DATE}.md`)

    expect(text).toContain('<!-- AUTO:SUMMARY:BEGIN -->')
    expect(text).toContain('<!-- AUTO:SUMMARY:END -->')
    expect(text.indexOf('## 待办')).toBeLessThan(text.indexOf('<!-- AUTO:SUMMARY:BEGIN -->'))
    // 备注段在「待办」之前结束，所以区块没有混进 note（parseRecord 的读法见文件头）
    expect(parseRecord(text, TRAINING_DATE).note).not.toContain('AUTO:SUMMARY')
  })
})

describe('工作区文本导出：foods.csv', () => {
  it('列序与 gen-seed.mjs 读的列名一致，逗号与引号被转义', async () => {
    await upsertFood({
      name: '测试,"食物"',
      category: '测试',
      unit: '100g',
      kcal: 100,
      proteinG: 10,
      fatG: 2,
      carbG: 3,
      fiberG: 4,
      sodiumMg: 5,
      source: 'llm',
      confidence: 'medium'
    })
    const files = await buildWorkspaceExport()
    const lines = fileOf(files, 'data/foods.csv').trim().split('\n')
    expect(lines[0]).toBe('name,category,unit,kcal,protein_g,fat_g,carb_g,fiber_g,sodium_mg,note')
    const row = lines.find((line) => line.startsWith('"测试,""食物"""'))
    expect(row).toBeDefined()
    expect(row).toContain('来源：模型（置信度 中）')
    expect(lines).toHaveLength((await countFoods()) + 1)
  })
})

describe('工作区文本导出：档案与目标', () => {
  it('profile.md / targets.md 的 front-matter 能被读回来，值不变', async () => {
    await seedSingletons()
    const files = await buildWorkspaceExport()

    const profile = parseFrontMatter(fileOf(files, 'profile.md')).front
    expect(profile.sex).toBe('male')
    expect(numFromCell(profile.age)).toBe(30)
    expect(numFromCell(profile.height_cm)).toBe(175)
    expect(numFromCell(profile.weight_kg)).toBe(75)
    expect(profile.goal).toBe('减脂')
    expect(profile.training_level).toBe('新手')
    expect(fileOf(files, 'profile.md')).toContain('- 不记录饮水')

    const targets = parseFrontMatter(fileOf(files, 'targets.md')).front
    expect(numFromCell(targets.kcal_target)).toBe(2240)
    expect(numFromCell(targets.protein_target_g)).toBe(150)
    expect(numFromCell(targets.sodium_max_mg)).toBe(2300)
    expect(numFromCell(targets.target_rate_kg_per_week)).toBe(-0.36)
    expect(targets.review_cadence).toBe('weekly')
    expect(targets.last_calibrated).toBe('2026-10-10')
  })

  it('没填档案 / 没校准时不生成空壳文件', async () => {
    await seedTrainingDay()
    const files = await buildWorkspaceExport()
    expect(files.map((file) => file.path)).toEqual(['records/2026-10-14.md', 'data/foods.csv'])
  })
})

describe('工作区文本导出：文本包', () => {
  it('文件名带日期，bundle → split 往返一致', async () => {
    expect(workspaceExportFileName('2026-10-16')).toBe('薄肌计划-工作区-2026-10-16.md')
    await seedFromFixtures()
    await seedTrainingDay()
    await seedSingletons()
    const files = await buildWorkspaceExport()
    expect(splitWorkspaceBundle(bundleWorkspaceFiles(files))).toEqual(files)
  })

  it('统计口径与文件列表一致', async () => {
    await seedFromFixtures()
    await seedSingletons()
    const files = await buildWorkspaceExport()
    const stats = workspaceExportStats(files)
    expect(stats.records).toBe(5)
    expect(stats.foods).toBe(await countFoods())
    expect(stats.lines).toBeGreaterThan(0)
  })
})
