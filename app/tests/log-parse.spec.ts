import { beforeEach, describe, expect, it } from 'vitest'
import { parseLog } from '@/application/logParse'
import { db } from '@/data/db'
import { upsertFood } from '@/data/repositories/foods'
import { getDraft, listOpenDrafts } from '@/data/repositories/drafts'
import { listOpenOps } from '@/data/repositories/pendingOps'
import { chatOk, stubFetch } from './helpers/llm'
import { FOOD_SEED_VERSION, foodSeed } from '@/data/seed'
import { seedFoods } from '@/data/repositories/foods'
import type { ModelConfigRecord } from '@/domain/types'

const TEXT = '今天中午吃了一顿西红柿鸡蛋拌面，其中食材包含4个西红柿，5个鸡蛋，80g干重的干面条，油盐正常量'

function config(): ModelConfigRecord {
  return {
    id: 'current',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    timeoutMs: 1000,
    enabled: true,
    updatedAt: Date.now()
  }
}

const run = { config: config(), sleep: async () => undefined, retryDelayMs: 0, skipLog: true }

const intakePayload = {
  kind: 'intake',
  meal: '午餐',
  dish: '西红柿鸡蛋拌面',
  items: [
    { food: '西红柿', amountText: '4个', grams: 600, pending: false, confidence: 'medium' },
    { food: '鸡蛋(全蛋 生)', amountText: '5个', grams: null, pending: false, confidence: 'high' },
    { food: '面条(干)', amountText: '80g', grams: 80, pending: false, confidence: 'high', cookedState: '生' },
    { food: '食用油', amountText: '正常量', grams: null, pending: true, confidence: 'low' }
  ],
  clarify: [
    { field: '面条(干).grams', question: '面条的 80g 是干重还是煮熟后的重量？', options: ['干重 80g', '熟重 80g'] }
  ],
  assumptions: [{ text: '1 个西红柿按 150g 计' }],
  uncertain: ['油盐用量'],
  rawText: TEXT
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await seedFoods(foodSeed, FOOD_SEED_VERSION)
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
    portions: [{ label: '1个', grams: 50 }],
    source: 'seed'
  })
})

describe('log.parse 应用层', () => {
  it('把任意描述变成草稿，并在本地能算的时候补上克数', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk(JSON.stringify(intakePayload))])
    const outcome = await parseLog({ date: '2026-10-15', text: TEXT, kind: 'intake' }, { ...run, deps: { fetchImpl } })

    if (outcome.status !== 'ok') throw new Error(`期望 ok，实际 ${outcome.status}`)
    const draft = outcome.draft
    expect(draft.kind).toBe('intake')
    expect(draft.rawText).toBe(TEXT)
    expect(draft.intake.map((item) => item.food)).toEqual(['西红柿', '鸡蛋(全蛋 生)', '面条(干)', '食用油'])

    // 「5个鸡蛋」库里登记了 1个 = 50g，本地就能折算，不必追问
    const egg = draft.intake[1]
    expect(egg.grams).toBe(250)
    expect(egg.pending).toBe(false)
    expect(draft.assumptions.join()).toContain('5个')

    // 油没克重 → 进澄清清单
    expect(outcome.plan.questions.map((question) => question.field)).toContain('食用油.grams')
    // 模型问的干重/熟重优先复用
    expect(outcome.plan.questions.find((question) => question.field === '面条(干).grams')?.source).toBe('model')

    // 只给名称、不给数值
    const payload = calls[0].body.messages as { content: string }[]
    const userPayload = JSON.parse(payload[1].content) as { knownFoods: string[] }
    expect(userPayload.knownFoods).toContain('鸡蛋(全蛋 生)')
    expect(payload[1].content).not.toContain('"kcal"')

    expect(await getDraft(draft.id)).toBeTruthy()
    expect((await listOpenDrafts('2026-10-15'))).toHaveLength(1)
  })

  it('只有克重齐了才把草稿标成 ready', async () => {
    const payload = {
      ...intakePayload,
      items: [{ food: '鸡蛋(全蛋 生)', amountText: '5个', grams: 250, pending: false, confidence: 'high' }],
      clarify: []
    }
    const { fetchImpl } = stubFetch([chatOk(JSON.stringify(payload))])
    const outcome = await parseLog({ date: '2026-10-15', text: '5个鸡蛋', kind: 'intake' }, { ...run, deps: { fetchImpl } })
    if (outcome.status !== 'ok') throw new Error('期望 ok')
    expect(outcome.draft.status).toBe('ready')
  })

  it('种类与入口不一致时返回 kind-mismatch，不静默改写', async () => {
    const workoutPayload = {
      kind: 'workout',
      type: '力量',
      minutes: 40,
      rpe: null,
      items: [{ exercise: '深蹲', sets: 4, reps: 8, weightKg: 60, bodyweight: false }],
      clarify: [],
      assumptions: [],
      uncertain: ['RPE'],
      rawText: '今天练了深蹲 4x8x60kg'
    }
    const { fetchImpl } = stubFetch([chatOk(JSON.stringify(workoutPayload))])
    const outcome = await parseLog(
      { date: '2026-10-15', text: '今天练了深蹲 4x8x60kg', kind: 'intake' },
      { ...run, deps: { fetchImpl } }
    )
    expect(outcome.status).toBe('kind-mismatch')
    if (outcome.status !== 'kind-mismatch') throw new Error('期望 kind-mismatch')
    expect(outcome.expected).toBe('intake')
    expect(outcome.actual).toBe('workout')
    expect(outcome.draft.workout.exercises[0]).toMatchObject({ exercise: '深蹲', sets: 4, reps: 8, weightKg: 60 })
  })

  it('模型失败也先把原文存成草稿并进队，绝不丢（DR-44）', async () => {
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    const outcome = await parseLog({ date: '2026-10-15', text: TEXT, kind: 'intake' }, { ...run, deps: { fetchImpl } })

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('期望 failed')
    expect(outcome.queued).toBe(true)
    expect(outcome.draft.rawText).toBe(TEXT)
    expect(await getDraft(outcome.draft.id)).toBeTruthy()

    const ops = await listOpenOps()
    expect(ops[0]).toMatchObject({ kind: 'log.parse', ref: outcome.draft.id, status: 'waiting' })
  })

  it('空输入直接提示，不发请求', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{}')])
    const outcome = await parseLog({ date: '2026-10-15', text: '   ', kind: 'intake' }, { ...run, deps: { fetchImpl } })
    expect(outcome.status).toBe('failed')
    expect(calls).toHaveLength(0)
  })

  it('图片按 content 数组随文字一起发，本地只记张数', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk(JSON.stringify({ ...intakePayload, items: [] }))])
    const image = 'data:image/jpeg;base64,AAAA'
    const outcome = await parseLog(
      { date: '2026-10-15', text: '看照片', kind: 'intake', images: [image, image, image, image] },
      { ...run, deps: { fetchImpl } }
    )
    if (outcome.status === 'failed') throw new Error('期望不失败')
    expect(outcome.draft.imageCount).toBe(3)

    const messages = calls[0].body.messages as { role: string; content: unknown }[]
    const userMessage = messages[1]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const parts = userMessage.content as { type: string }[]
    expect(parts.filter((part) => part.type === 'image_url')).toHaveLength(3)
    expect(parts[0].type).toBe('text')
  })
})
