/**
 * 工作区文本导出的测试夹具（T4.2）。
 *
 * 两件事：把 `tests/fixtures/` 里的合成记录按**真机写入路径**（同一批仓储函数）灌进库，
 * 再补一天只记训练的日子（fixtures 的训练表都是空的，容量负荷那条路径得有人踩）。
 *
 * 数据全是合成的：仓库里不许出现真实记录（AGENTS.md）。
 */

import { addIntake } from '@/data/repositories/intake'
import { addWorkout } from '@/data/repositories/workout'
import { updateDay } from '@/data/repositories/days'
import { saveProfile } from '@/data/repositories/profile'
import { putTargets } from '@/data/repositories/targets'
import { numFromCell, parseFrontMatter } from '@/io/markdown/record'
import type { ProfileRecord, TargetsRecord } from '@/domain/types'
import type { WorkspaceFile } from '@/io/workspaceExport'
import { loadRecordFixtures, readFixture, toIntakeEntries, toWorkoutEntries } from './fixtures'

/** 只记训练、不记摄入的一天：`组x次x重量` 与容量负荷要能原样回来。 */
export const TRAINING_DATE = '2026-10-14'

export async function seedTrainingDay(): Promise<void> {
  await updateDay(TRAINING_DATE, {
    weightAmKg: 75,
    weightPmKg: 75.6,
    sleepHours: 7,
    energy: 4,
    soreness: 2,
    note: '测试备注\n第二行备注',
    todos: [
      { text: '补一次晨重', done: false },
      { text: '买乳清', done: true }
    ]
  })
  await addWorkout({
    date: TRAINING_DATE,
    time: '19:30',
    type: '力量',
    minutes: 45,
    rpe: 8,
    muscles: ['胸', '三头'],
    exercise: '卧推',
    sets: Array.from({ length: 4 }, () => ({ reps: 8, weightKg: 60, bodyweight: false })),
    volumeRaw: '4x8x60',
    volumeLoad: 1920
  })
  await addWorkout({
    date: TRAINING_DATE,
    type: '力量',
    muscles: ['腹'],
    exercise: '卷腹',
    sets: Array.from({ length: 3 }, () => ({ reps: 12, bodyweight: true })),
    volumeRaw: '3x12x自重'
  })
  await addWorkout({
    date: TRAINING_DATE,
    type: '有氧',
    minutes: 30,
    muscles: ['全身'],
    exercise: '慢跑',
    estimatedKcal: 260
  })
}

/** 把 fixtures 里的合成记录灌进库。 */
export async function seedFromFixtures(): Promise<void> {
  for (const record of loadRecordFixtures()) {
    await updateDay(record.date, {
      weekday: record.weekday,
      weightAmKg: record.weightAmKg,
      weightPmKg: record.weightPmKg,
      sleepHours: record.sleepHours,
      energy: record.energy,
      soreness: record.soreness,
      note: record.note,
      todos: record.todos
    })
    for (const entry of toIntakeEntries(record)) {
      const { id: _ignored, ...rest } = entry
      await addIntake(rest)
    }
    for (const entry of toWorkoutEntries(record)) {
      const { id: _ignored, ...rest } = entry
      await addWorkout(rest)
    }
  }
}

/** 档案与目标单例，值取自 fixtures 的合成档案 / 合成目标。 */
export async function seedSingletons(): Promise<void> {
  const profile = parseFrontMatter(readFixture('profile.md')).front
  const record: ProfileRecord = {
    id: 'current',
    name: profile.name || undefined,
    sex: profile.sex === 'female' ? 'female' : 'male',
    age: numFromCell(profile.age) ?? 30,
    heightCm: numFromCell(profile.height_cm) ?? 175,
    weightKg: numFromCell(profile.weight_kg) ?? 75,
    bodyFatPct: numFromCell(profile.body_fat_pct),
    goal: '减脂',
    trainingLevel: '新手',
    trainingYears: numFromCell(profile.training_years),
    wakeTime: profile.wake_time,
    sleepTime: profile.sleep_time,
    conventions: ['体重默认口径：晨起排尿后、空腹', '不记录饮水'],
    updatedAt: Date.now()
  }
  await saveProfile(record)

  const front = parseFrontMatter(readFixture('targets.md')).front
  const num = (key: string, fallback = 0): number => numFromCell(front[key]) ?? fallback
  const targets: Omit<TargetsRecord, 'id' | 'updatedAt'> = {
    tdeeKcal: num('tdee_kcal'),
    kcalTarget: num('kcal_target'),
    proteinTargetG: num('protein_target_g'),
    fatTargetG: num('fat_target_g'),
    carbTargetG: num('carb_target_g'),
    fiberTargetG: num('fiber_target_g'),
    sodiumMaxMg: num('sodium_max_mg'),
    weeklyTrainingDays: num('weekly_training_days'),
    weeklySetsPerMuscle: num('weekly_sets_per_muscle'),
    targetWeightKg: num('target_weight_kg'),
    targetRateKgPerWeek: num('target_rate_kg_per_week'),
    reviewCadence: 'weekly',
    lastCalibrated: front.last_calibrated
  }
  await putTargets(targets)
}

export function fileOf(files: readonly WorkspaceFile[], path: string): string {
  const found = files.find((file) => file.path === path)
  if (!found) throw new Error(`导出里没有 ${path}`)
  return found.text
}
