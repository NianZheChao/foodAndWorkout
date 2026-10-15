import { beforeEach, describe, expect, it } from 'vitest'
import { resolveFoods, persistCandidate } from '@/application/foodResolve'
import { findFoodFuzzy } from '@/application/foodLibrary'
import { db } from '@/data/db'
import { findByNormalizedName, upsertFood } from '@/data/repositories/foods'
import { listOpenOps } from '@/data/repositories/pendingOps'
import { chatOk, stubFetch } from './helpers/llm'
import type { ModelConfigRecord } from '@/domain/types'

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

function item(patch: Record<string, unknown>): string {
  return JSON.stringify({ items: [patch] })
}

const run = { config: config(), sleep: async () => undefined, retryDelayMs: 0, skipLog: true }

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await upsertFood({
    name: '鸡蛋(全蛋 生)',
    category: '蛋奶',
    unit: '100g',
    kcal: 144,
    proteinG: 13.3,
    fatG: 8.8,
    carbG: 2.8,
    fiberG: 0,
    sodiumMg: 131,
    source: 'seed'
  })
})

describe('本地优先（FR-1408）', () => {
  it('库里已有的食物不发请求', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{}')])
    const outcome = await resolveFoods(['鸡蛋(全蛋 生)'], { ...run, deps: { fetchImpl } })
    expect(outcome.candidates[0]).toMatchObject({ matched: true, fromCache: true })
    expect(outcome.candidates[0].food?.kcal).toBe(144)
    expect(calls).toHaveLength(0)
  })

  it('说法只写到主名（「鸡蛋」）也能命中库里带括号的条目', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{}')])
    const outcome = await resolveFoods(['鸡蛋'], { ...run, deps: { fetchImpl } })
    expect(outcome.candidates[0].food?.name).toBe('鸡蛋(全蛋 生)')
    expect(calls).toHaveLength(0)
  })

  it('括号里的生熟不能被抹掉：面条(干) 不会命中 面条(煮熟)', async () => {
    await upsertFood({
      name: '面条(煮熟)',
      category: '主食',
      unit: '100g',
      kcal: 109,
      proteinG: 3.9,
      fatG: 0.4,
      carbG: 22.4,
      fiberG: 0.5,
      sodiumMg: 3.2,
      source: 'seed'
    })
    // 带了状态就不能模糊匹配：干面条与熟面条差三倍
    expect(await findFoodFuzzy('面条(干)')).toBeUndefined()
    // 完全没说状态时，唯一候选才允许命中
    expect((await findFoodFuzzy('面条'))?.name).toBe('面条(煮熟)')
    // 主名命中多条但数值一致（鸡蛋(全蛋 生) / 鸡蛋(水煮)）→ 可以取
    expect((await findFoodFuzzy('鸡蛋'))?.name).toContain('鸡蛋')
  })
})

describe('未知食物走模型 + 本地校验', () => {
  it('正常返回直接可用，并标出来源', async () => {
    const { fetchImpl, calls } = stubFetch([
      chatOk(
        item({
          query: '凯撒沙拉',
          matched: true,
          name: '凯撒沙拉(市售)',
          category: '沙拉',
          unit: '100g',
          kcal: 100.1,
          protein_g: 7,
          fat_g: 5.3,
          carb_g: 6.1,
          fiber_g: 0,
          sodium_mg: 285,
          confidence: 'high'
        })
      )
    ])
    const outcome = await resolveFoods(['凯撒沙拉'], { ...run, deps: { fetchImpl } })
    const candidate = outcome.candidates[0]
    expect(calls).toHaveLength(1)
    expect(candidate).toMatchObject({ matched: true, fromCache: false, needsConfirm: false, suspicious: [] })
    expect(candidate.food).toMatchObject({ name: '凯撒沙拉(市售)', kcal: 100.1, source: 'llm', unit: '100g' })
  })

  it('数值越界标为可疑，需要用户确认（FR-407）', async () => {
    const { fetchImpl } = stubFetch([
      chatOk(item({ query: '怪东西', matched: true, name: '怪东西', kcal: 1500, protein_g: 5, fat_g: 5, carb_g: 5, sodium_mg: 120 }))
    ])
    const outcome = await resolveFoods(['怪东西'], { ...run, deps: { fetchImpl } })
    expect(outcome.candidates[0].suspicious.join()).toContain('热量')
    expect(outcome.candidates[0].needsConfirm).toBe(true)
  })

  it('宏量折算对不上标为可疑；酒类豁免', async () => {
    const off = stubFetch([
      chatOk(item({ query: '神秘饼干', matched: true, name: '神秘饼干', kcal: 600, protein_g: 5, fat_g: 5, carb_g: 5 }))
    ])
    const first = await resolveFoods(['神秘饼干'], { ...run, deps: { fetchImpl: off.fetchImpl } })
    expect(first.candidates[0].suspicious.join()).toContain('宏量')

    const wine = stubFetch([
      chatOk(item({ query: '白酒', matched: true, name: '白酒', kcal: 298, protein_g: 0, fat_g: 0, carb_g: 0.1, sodium_mg: 1 }))
    ])
    const second = await resolveFoods(['白酒'], { ...run, deps: { fetchImpl: wine.fetchImpl } })
    expect(second.candidates[0].suspicious).toEqual([])
  })

  it('matched=false 时不落库，提示手工录入', async () => {
    const { fetchImpl } = stubFetch([chatOk(item({ query: '妈妈牌红烧肉', matched: false }))])
    const outcome = await resolveFoods(['妈妈牌红烧肉'], { ...run, deps: { fetchImpl } })
    expect(outcome.candidates[0]).toMatchObject({ matched: false, needsConfirm: true })
    expect(outcome.candidates[0].food).toBeUndefined()
    expect(await findByNormalizedName('妈妈牌红烧肉')).toBeUndefined()
  })

  it('入库时提示合并而不是新增（FR-408）', async () => {
    const { fetchImpl } = stubFetch([
      chatOk(item({ query: '走地鸡蛋', matched: true, name: '鸡蛋(全蛋 生)', kcal: 144, protein_g: 13.3, fat_g: 8.8, carb_g: 2.8 }))
    ])
    const outcome = await resolveFoods(['走地鸡蛋'], { ...run, deps: { fetchImpl } })
    expect(outcome.candidates[0]).toMatchObject({ existingKind: 'exact', fromCache: false })
    expect(outcome.candidates[0].existing?.name).toBe('鸡蛋(全蛋 生)')
    expect(outcome.candidates[0].food?.source).toBe('seed')
  })

  it('用户确认后落库，来源记为 llm', async () => {
    const { fetchImpl } = stubFetch([
      chatOk(item({ query: '魔芋丝', matched: true, name: '魔芋丝', kcal: 10, protein_g: 0.1, fat_g: 0, carb_g: 2.4, sodium_mg: 5 }))
    ])
    const outcome = await resolveFoods(['魔芋丝'], { ...run, deps: { fetchImpl } })
    const saved = await persistCandidate(outcome.candidates[0].food as NonNullable<typeof outcome.candidates[0]['food']>)
    expect(saved.source).toBe('llm')
    expect((await findByNormalizedName('魔芋丝'))?.kcal).toBe(10)
  })
})

describe('失败降级（DR-44 / FR-1504）', () => {
  it('网络失败不抛异常：返回 failure 并把查询放进待办队列等网络', async () => {
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    const outcome = await resolveFoods(['未知食物'], { ...run, deps: { fetchImpl } })
    expect(outcome.candidates).toHaveLength(0)
    expect(outcome.failure?.retriable).toBe(true)
    expect(outcome.queued).toEqual(['未知食物'])

    const ops = await listOpenOps()
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'food.resolve', ref: '未知食物', status: 'waiting', attempts: 0 })
  })

  it('未配置模型时不发请求，直接进队列', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{}')])
    const outcome = await resolveFoods(['未知食物'], {
      ...run,
      config: config({ apiKey: '' }),
      deps: { fetchImpl }
    })
    expect(calls).toHaveLength(0)
    expect(outcome.failure?.kind).toBe('not-configured')
    expect(outcome.queued).toEqual(['未知食物'])
  })
})

