// @vitest-environment node
/**
 * B 级生成式推荐的安全边界（T3.8 / FR-1003）。
 *
 * 这一组用例守的是「**推荐不许推荐出用户吃不了的东西**」这条底线：
 * 门禁算得对（缺哪项说哪项）、约束是「已确认」的语义（没有就填「无」，0 与留空都不算填）、
 * 约束能被拆开与导出（不会填了却没人读）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/data/db'
import {
  isRecommendEnabled,
  missingRecommendConstraints,
  parseConstraintList,
  recommendConstraintLines,
  recommendConstraintsReady
} from '@/domain/recommend'
import { defaultSettings, getSettings, saveSettings } from '@/data/repositories/settings'
import { getProfile, saveProfile } from '@/data/repositories/profile'
import { renderProfileFile } from '@/io/markdown/export'
import type { ProfileRecord } from '@/domain/types'

const READY: ProfileRecord = {
  id: 'current',
  sex: 'male',
  age: 30,
  heightCm: 175,
  weightKg: 75,
  goal: '减脂',
  trainingLevel: '新手',
  conventions: [],
  avoidFoods: ['香菜'],
  allergies: ['无'],
  equipment: ['杠铃', '哑铃'],
  mealMinutes: 20,
  updatedAt: Date.now()
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('约束门禁（FR-1003）', () => {
  it('还没填档案时四项全缺', () => {
    expect(missingRecommendConstraints(undefined)).toEqual(['忌口', '过敏', '可用器材', '每餐时间'])
    expect(recommendConstraintsReady(undefined)).toBe(false)
  })

  it('缺哪项说哪项，只缺一部分时就只列那一部分', () => {
    expect(missingRecommendConstraints({ ...READY, allergies: [] })).toEqual(['过敏'])
    expect(missingRecommendConstraints({ ...READY, equipment: [], mealMinutes: undefined })).toEqual([
      '可用器材',
      '每餐时间'
    ])
    expect(recommendConstraintsReady(READY)).toBe(true)
  })

  it('「无」是填过的意思：没有忌口 / 过敏就必须写「无」，留空不算（DR-04）', () => {
    expect(missingRecommendConstraints({ ...READY, avoidFoods: ['无'] })).toEqual([])
    // 只填空白字符 = 没填
    expect(missingRecommendConstraints({ ...READY, avoidFoods: ['  '] })).toEqual(['忌口'])
    // 0 分钟不是「已填」：拿 0 顶替未知会让推荐按「没时间做饭」去排
    expect(missingRecommendConstraints({ ...READY, mealMinutes: 0 })).toEqual(['每餐时间'])
    expect(missingRecommendConstraints({ ...READY, mealMinutes: Number.NaN })).toEqual(['每餐时间'])
  })
})

describe('约束的拆分与呈现', () => {
  it('换行 / 逗号 / 顿号 / 分号都认，去空去重保序', () => {
    expect(parseConstraintList('香菜、内脏\n折耳根, 香菜；  ')).toEqual(['香菜', '内脏', '折耳根'])
    expect(parseConstraintList('')).toEqual([])
  })

  it('拼成给模型看的行：缺的写「未填」，别装作有', () => {
    expect(recommendConstraintLines(READY)).toEqual([
      '忌口：香菜',
      '过敏：无',
      '可用器材：杠铃 / 哑铃',
      '每餐时间：20'
    ])
    expect(recommendConstraintLines({ ...READY, mealMinutes: undefined })).toContain('每餐时间：未填')
    expect(recommendConstraintLines(undefined)).toEqual([])
  })

  it('开关读法：老数据没有这个键就是关（默认关）', () => {
    expect(isRecommendEnabled(undefined)).toBe(false)
    expect(isRecommendEnabled(defaultSettings())).toBe(false)
    expect(isRecommendEnabled({ ...defaultSettings(), recommendEnabled: true })).toBe(true)
  })
})

describe('约束的存取与导出', () => {
  it('设置里默认关；存下来读回来还是关 / 开', async () => {
    expect((await getSettings()).recommendEnabled).toBe(false)
    await saveSettings({ recommendEnabled: true })
    expect((await getSettings()).recommendEnabled).toBe(true)
  })

  it('档案里的四项能存能读回（老档案没有这些键时按空处理）', async () => {
    await saveProfile(READY)
    const saved = await getProfile()
    expect(saved?.avoidFoods).toEqual(['香菜'])
    expect(saved?.equipment).toEqual(['杠铃', '哑铃'])
    expect(saved?.mealMinutes).toBe(20)

    await saveProfile({ ...READY, avoidFoods: undefined, allergies: undefined, equipment: undefined, mealMinutes: undefined })
    expect(missingRecommendConstraints(await getProfile())).toEqual(['忌口', '过敏', '可用器材', '每餐时间'])
  })

  it('导出的 profile.md 里有这一节（填了才写，不会留一堆空行）', async () => {
    const text = renderProfileFile(READY)
    expect(text).toContain('## 饮食与训练约束')
    expect(text).toContain('- 忌口：香菜')
    expect(text).toContain('- 可用器材：杠铃、哑铃')
    expect(text).toContain('- 每餐可投入时间：20 分钟')

    const empty = renderProfileFile({ ...READY, avoidFoods: [], allergies: [], equipment: [], mealMinutes: undefined })
    expect(empty).not.toContain('饮食与训练约束')
  })
})