// @vitest-environment jsdom
/**
 * 今日指导页（T3.7 / §6.4.2 / FR-1602）。
 *
 * 守页面层的三件事：没配模型时**不装死**（本地缺口提示 + 说明原因）、
 * 已生成的指导能看依据与表态、**将要发送的内容**看得见且睡眠能单独关掉。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import CoachPage from '@/pages/CoachPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { listRecentAdvice, putAdvice } from '@/data/repositories/adviceLog'
import { getSettings } from '@/data/repositories/settings'
import { putTargets } from '@/data/repositories/targets'
import { addIntake } from '@/data/repositories/intake'
import { todayIso } from '@/app/date'
import type { AdviceRecord } from '@/domain/types'

const TODAY = todayIso()

async function mountCoach(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/coach')
  await router.isReady()
  return mount(CoachPage, { global: { plugins: [createPinia(), router] } })
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

async function seedTodayIntake(): Promise<void> {
  await addIntake({
    date: TODAY,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: {
      name: '测试食材',
      unit: '100g',
      kcal: 1200,
      proteinG: 60,
      fatG: 40,
      carbG: 100,
      fiberG: 8,
      sodiumMg: 1500
    },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 1200, proteinG: 60, fatG: 40, carbG: 100, fiberG: 8, sodiumMg: 1500 }
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

describe('今日指导页', () => {
  it('没配模型时不装死：说明原因，并照常给本地缺口提示', async () => {
    await seedTodayIntake()
    const wrapper = await mountCoach()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('今天还没有指导')
      expect(wrapper.text()).toContain('本地缺口提示')
      // 蛋白 60 g / 目标 140 g：本地就能算出缺口，不需要模型
      expect(wrapper.text()).toContain('蛋白质差 80 g')
    })

    await button(wrapper, '生成今日指导').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('没能生成 AI 指导')
      expect(wrapper.text()).toContain('模型设置')
    })
    expect(await listRecentAdvice()).toEqual([])
  })

  it('已生成的指导：显示依据、能表态、数据变了会提示刷新', async () => {
    await seedTodayIntake()
    const record: AdviceRecord = {
      id: 'adv_test',
      date: TODAY,
      fingerprint: 'stale-fingerprint',
      content: {
        headline: '蛋白偏低，今天先把它补上。',
        advice: [
          { kind: 'fact', text: '今天的蛋白还差不少。', basis: ['today.remainingProteinG'] }
        ],
        focus: ['晚饭先把蛋白补上'],
        ask: ['今天还练不练？'],
        disclaimer: '仅供参考。'
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await putAdvice(record)

    const wrapper = await mountCoach()
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('蛋白偏低，今天先把它补上。')
      expect(wrapper.text()).toContain('依据：today.remainingProteinG')
      expect(wrapper.text()).toContain('事实')
      expect(wrapper.text()).toContain('数据已经变了')
    })

    await button(wrapper, '采纳').trigger('click')
    await vi.waitFor(async () => {
      const rows = await listRecentAdvice()
      expect(rows[0].content.advice[0].adopted).toBe(true)
    })
    await flushPromises()
    expect(wrapper.text()).toContain('已采纳')
  })

  it('FR-1602：发送内容看得见，睡眠可以单独关掉', async () => {
    await seedTodayIntake()
    await db.days.put({
      date: TODAY,
      weekday: '五',
      sleepHours: 5,
      pendingCount: 0,
      createdAt: 1,
      updatedAt: 1
    })

    const wrapper = await mountCoach()
    await vi.waitFor(() => expect(wrapper.text()).toContain('将要发送的内容'))

    await button(wrapper, '展开').trigger('click')
    await flushPromises()
    // 摘要里睡眠是聚合后的数字（`avgSleepHours`），关掉之后连这一项都不该出现
    expect(wrapper.find('pre.payload').text()).toContain('avgSleepHours')

    const boxes = wrapper.findAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    await boxes[0].setValue(false)

    await vi.waitFor(async () => {
      const settings = await getSettings()
      expect(settings.shareRecovery?.sleep).toBe(false)
    })
    await vi.waitFor(() => {
      expect(wrapper.find('pre.payload').text()).not.toContain('avgSleepHours')
    })
    expect(wrapper.find('pre.payload').text()).toContain('"sleepDays": 0')
  })
})
