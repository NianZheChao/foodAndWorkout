/**
 * 待办队列执行器（T2.4 / §6.10 / FR-1504）。
 *
 * 守着三件事：没配模型 / 离线时**不写不请求**；只有干净结果才自动回填；
 * 可疑值、缺克数、只有图片的草稿都转成「需要处理」而不是硬猜。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { runQueue } from '@/application/queue'
import { resolveFoods } from '@/application/foodResolve'
import { parseLog } from '@/application/logParse'
import { db } from '@/data/db'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listOpenOps } from '@/data/repositories/pendingOps'
import { getDraft, putDraft } from '@/data/repositories/drafts'
import { findByNormalizedName } from '@/data/repositories/foods'
import { chatOk, stubFetch } from './helpers/llm'
import type { DraftRecord, ModelConfigRecord } from '@/domain/types'

const DATE = '2026-10-15'

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

function resolvedItem(patch: Record<string, unknown>): string {
  return JSON.stringify({ items: [patch] })
}

const run = { config: config(), sleep: async () => undefined, retryDelayMs: 0, skipLog: true }

/** 造一条「先占位、等联网补全」的摄入记录，并把查询写进队列。 */
async function seedPendingEntry(name: string, grams?: number): Promise<void> {
  await db.intake.put({
    id: `in_${name}`,
    date: DATE,
    meal: '午餐',
    dish: name,
    foodId: name,
    foodSnapshot: {
      name,
      unit: '100g',
      kcal: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      fiberG: 0,
      sodiumMg: 0
    },
    amount: { qty: 1, unit: grams === undefined ? '待补全' : `${grams}g`, grams },
    computed: { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 },
    pendingFlag: 1,
    note: '一句话记录原文'
  })
  await resolveFoods([name], {
    ...run,
    config: config({ apiKey: '' }),
    deps: { fetchImpl: stubFetch([chatOk('{}')]).fetchImpl }
  })
}

function draft(patch: Partial<DraftRecord> = {}): DraftRecord {
  const now = Date.now()
  return {
    id: 'draft_1',
    date: DATE,
    kind: 'intake',
    status: 'collecting',
    rawText: '中午吃了凯撒沙拉',
    imageCount: 0,
    meal: '午餐',
    dish: '',
    intake: [],
    workout: { type: '力量', exercises: [] },
    questions: [],
    assumptions: [],
    uncertain: [],
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('队列执行器：什么时候不动手', () => {
  it('没有待办时什么都不做', async () => {
    const report = await runQueue({ run })
    expect(report).toMatchObject({ ran: false, done: 0 })
  })

  it('未配置模型时不发请求、不改数据，队列原样等着', async () => {
    await seedPendingEntry('凯撒沙拉')
    const { fetchImpl, calls } = stubFetch([chatOk(resolvedItem({ query: '凯撒沙拉', matched: true, name: '凯撒沙拉', kcal: 100 }))])
    const report = await runQueue({ run: { ...run, config: config({ apiKey: '' }) }, online: true })

    expect(report.ran).toBe(false)
    expect(report.skipped.join()).toContain('还没有配置模型')
    expect(calls).toHaveLength(0)
    expect((await listOpenOps())[0].status).toBe('waiting')
    expect((await listIntakeByDate(DATE))[0].pendingFlag).toBe(1)
    void fetchImpl
  })

  it('离线时不跑（等联网事件再来）', async () => {
    await seedPendingEntry('凯撒沙拉')
    const report = await runQueue({ run, online: false })
    expect(report.ran).toBe(false)
    expect(report.skipped.join()).toContain('当前离线')
  })
})

describe('队列执行器：food.resolve 回填', () => {
  it('干净结果自动落库、按克数回算并清掉待补全标记', async () => {
    await seedPendingEntry('凯撒沙拉', 200)
    const { fetchImpl, calls } = stubFetch([
      chatOk(
        resolvedItem({
          query: '凯撒沙拉',
          matched: true,
          name: '凯撒沙拉(市售)',
          category: '沙拉',
          unit: '100g',
          kcal: 100,
          protein_g: 7,
          fat_g: 5.3,
          carb_g: 6.1,
          fiber_g: 1,
          sodium_mg: 285,
          confidence: 'high'
        })
      )
    ])
    const report = await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(report.ran).toBe(true)
    expect(report.done).toBe(1)
    expect(report.messages.join()).toContain('已自动补全')
    expect(calls).toHaveLength(1)

    const entry = (await listIntakeByDate(DATE))[0]
    expect(entry.pendingFlag).toBe(0)
    expect(entry.foodSnapshot.name).toBe('凯撒沙拉(市售)')
    // 每 100g 100 kcal、200g → 200 kcal
    expect(entry.computed.kcal).toBeCloseTo(200, 5)
    expect(entry.computed.proteinG).toBeCloseTo(14, 5)
    expect((await findByNormalizedName('凯撒沙拉(市售)'))?.source).toBe('llm')
    // 队列项收口：`listOpenOps` 只返回未完成的，这里直接看原始行
    expect(await listOpenOps()).toHaveLength(0)
    expect((await db.pendingOps.toArray())[0].status).toBe('done')
  })

  it('可疑数值不自动回填，转「需要处理」并把原因写进队列项（FR-407）', async () => {
    await seedPendingEntry('怪东西', 100)
    const { fetchImpl } = stubFetch([
      chatOk(resolvedItem({ query: '怪东西', matched: true, name: '怪东西', kcal: 1500, protein_g: 5, fat_g: 5, carb_g: 5 }))
    ])
    const report = await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(report.needsAttention).toBe(1)
    expect(report.messages.join()).toContain('需要你确认')
    const entry = (await listIntakeByDate(DATE))[0]
    expect(entry.pendingFlag).toBe(1)
    expect(entry.foodSnapshot.name).toBe('怪东西')
    const op = (await listOpenOps())[0]
    expect(op.status).toBe('needs-attention')
    expect(op.lastError).toContain('热量')
    expect(await findByNormalizedName('怪东西')).toBeUndefined()
  })

  it('只有份量写法、没有克数时不硬猜，提示补克数', async () => {
    await seedPendingEntry('凯撒沙拉')
    const { fetchImpl } = stubFetch([
      chatOk(resolvedItem({ query: '凯撒沙拉', matched: true, name: '凯撒沙拉(市售)', kcal: 100, protein_g: 7, fat_g: 5, carb_g: 6, confidence: 'high' }))
    ])
    const report = await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(report.needsAttention).toBe(1)
    expect(report.messages.join()).toContain('没有克数')
    expect((await listIntakeByDate(DATE))[0].pendingFlag).toBe(1)
  })

  it('网络失败时留在队列里等下次，不写任何数据', async () => {
    await seedPendingEntry('凯撒沙拉', 100)
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    const report = await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(report.ran).toBe(true)
    expect(report.waiting).toBe(1)
    const op = (await listOpenOps())[0]
    expect(op.status).toBe('waiting')
    expect(op.attempts).toBe(1)
    expect((await listIntakeByDate(DATE))[0].pendingFlag).toBe(1)
  })

  it('重放失败不会把队列越滚越长（不重复入队）', async () => {
    await seedPendingEntry('凯撒沙拉', 100)
    const before = (await listOpenOps()).length
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    await runQueue({ run: { ...run, deps: { fetchImpl } } })
    expect((await listOpenOps()).length).toBe(before)
  })

  it('同一查询排了多条队时只请求一次，并一起收口', async () => {
    await seedPendingEntry('凯撒沙拉', 100)
    // 用户重复提交 → 队列里又多一条同样的查询
    await resolveFoods(['凯撒沙拉'], {
      ...run,
      config: config({ apiKey: '' }),
      deps: { fetchImpl: stubFetch([chatOk('{}')]).fetchImpl }
    })
    expect((await listOpenOps()).length).toBe(2)

    const { fetchImpl, calls } = stubFetch([
      chatOk(resolvedItem({ query: '凯撒沙拉', matched: true, name: '凯撒沙拉(市售)', kcal: 100, protein_g: 7, fat_g: 5, carb_g: 6, confidence: 'high' }))
    ])
    await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(calls).toHaveLength(1)
    expect((await listOpenOps()).length).toBe(0)
  })
})

describe('队列执行器：log.parse 重放', () => {
  const parsePayload = JSON.stringify({
    kind: 'intake',
    meal: '午餐',
    dish: '凯撒沙拉',
    items: [{ food: '凯撒沙拉', amountText: '200g', grams: 200, pending: false, confidence: 'high' }],
    clarify: [],
    assumptions: [],
    uncertain: [],
    rawText: '中午吃了凯撒沙拉'
  })

  it('用草稿里的原文重新解析，成功后关闭队列项', async () => {
    await putDraft(draft())
    // 先制造一条 log.parse 队列项（未配模型时的正常路径）
    await parseLog(
      { date: DATE, text: '中午吃了凯撒沙拉', kind: 'intake', draftId: 'draft_1' },
      { ...run, config: config({ apiKey: '' }), deps: { fetchImpl: stubFetch([chatOk('{}')]).fetchImpl } }
    )
    expect((await listOpenOps())[0]).toMatchObject({ kind: 'log.parse', ref: 'draft_1', status: 'waiting' })

    const { fetchImpl } = stubFetch([chatOk(parsePayload)])
    const report = await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(report.done).toBe(1)
    expect(report.messages.join()).toContain('重新解析完成')
    const saved = await getDraft('draft_1')
    expect(saved?.intake[0]).toMatchObject({ food: '凯撒沙拉', grams: 200 })
    expect((await listOpenOps()).length).toBe(0)
  })

  it('只有图片的草稿不硬猜，转「需要处理」', async () => {
    await putDraft(draft({ rawText: '', imageCount: 1 }))
    await parseLog(
      { date: DATE, text: '', kind: 'intake', draftId: 'draft_1', images: ['data:image/jpeg;base64,AAAA'] },
      { ...run, config: config({ apiKey: '' }), deps: { fetchImpl: stubFetch([chatOk('{}')]).fetchImpl } }
    )

    const { fetchImpl, calls } = stubFetch([chatOk(parsePayload)])
    const report = await runQueue({ run: { ...run, deps: { fetchImpl } } })

    expect(calls).toHaveLength(0)
    expect(report.needsAttention).toBe(1)
    expect(report.messages.join()).toContain('只有图片')
    expect((await listOpenOps())[0].status).toBe('needs-attention')
  })
})
