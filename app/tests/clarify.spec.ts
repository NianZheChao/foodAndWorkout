import { describe, expect, it } from 'vitest'
import { buildClarifyPlan, isResolved, isSeasoning, parseClarifyAnswer, resolveGrams } from '@/domain/clarify'

describe('parseClarifyAnswer', () => {
  it('认出克重与生熟', () => {
    expect(parseClarifyAnswer('干重 80g')).toMatchObject({ kind: 'value', grams: 80, cookedState: '生' })
    expect(parseClarifyAnswer('熟重 80g')).toMatchObject({ kind: 'value', grams: 80, cookedState: '熟' })
    expect(parseClarifyAnswer('共 200g')).toMatchObject({ kind: 'value', grams: 200 })
    expect(parseClarifyAnswer('没量过，按 10g 估')).toMatchObject({ kind: 'value', grams: 10 })
  })

  it('按常见计量词折算：半碗 = 75g', () => {
    expect(parseClarifyAnswer('半碗')).toMatchObject({ kind: 'value', grams: 75 })
    expect(parseClarifyAnswer('2勺')).toMatchObject({ kind: 'value', grams: 30 })
  })

  it('组次与时长给出数值而不是克数', () => {
    expect(parseClarifyAnswer('3组')).toMatchObject({ kind: 'value', number: 3 })
    expect(parseClarifyAnswer('8次')).toMatchObject({ kind: 'value', number: 8 })
    expect(parseClarifyAnswer('45 分钟')).toMatchObject({ kind: 'value', minutes: 45, number: 45 })
    expect(parseClarifyAnswer('1小时')).toMatchObject({ kind: 'value', minutes: 60 })
  })

  it('明确的「不记 / 记不清」算 skip，含糊的算 unknown', () => {
    expect(parseClarifyAnswer('不记')).toEqual({ kind: 'skip' })
    expect(parseClarifyAnswer('记不清')).toEqual({ kind: 'skip' })
    expect(parseClarifyAnswer('')).toEqual({ kind: 'unknown' })
    expect(parseClarifyAnswer('随便吧')).toEqual({ kind: 'unknown' })
  })
})

describe('必须问 vs 可以估', () => {
  it('缺克重就是阻塞项，有克重就不问', () => {
    const plan = buildClarifyPlan({
      kind: 'intake',
      intake: [
        { key: 'a', food: '面条(干)', amountText: '80g', grams: 80, pending: false },
        { key: 'b', food: '西红柿', amountText: '4个' }
      ]
    })
    expect(plan.questions).toHaveLength(1)
    expect(plan.questions[0]).toMatchObject({ field: '西红柿.grams', blocking: true, source: 'local' })
    expect(plan.questions[0].options.length).toBeGreaterThan(1)
  })

  it('模型自带的问题优先复用，同字段不重复问', () => {
    const plan = buildClarifyPlan({
      kind: 'intake',
      intake: [{ key: 'a', food: '面条(干)', amountText: '80g' }],
      modelQuestions: [{ field: '面条(干).grams', question: '面条的 80g 是干重还是煮熟后的重量？', options: ['干重 80g', '熟重 80g'] }]
    })
    expect(plan.questions).toHaveLength(1)
    expect(plan.questions[0]).toMatchObject({ source: 'model', blocking: true })
    expect(plan.questions[0].question).toContain('干重')
  })

  it('油盐类即便给了克重也默认问一次，但不阻塞', () => {
    const plan = buildClarifyPlan({
      kind: 'intake',
      intake: [{ key: 'a', food: '食用油', amountText: '一点', grams: undefined }]
    })
    expect(plan.questions.map((question) => question.field)).toContain('食用油.grams')
    expect(plan.questions.find((question) => question.field === '食用油.grams')?.blocking).toBe(true)

    const withGrams = buildClarifyPlan({
      kind: 'intake',
      intake: [{ key: 'a', food: '食用油', grams: 10, pending: false }]
    })
    expect(withGrams.questions.find((question) => question.field === '食用油.grams')?.blocking).toBe(false)
  })

  it('训练：缺时长（非力量）与缺组次都问，RPE 不缺就不问', () => {
    const plan = buildClarifyPlan({
      kind: 'workout',
      workout: {
        type: '有氧',
        exercises: [{ key: 'w1', exercise: '深蹲', sets: 4, reps: 8, weightKg: 60 }]
      }
    })
    expect(plan.questions.map((question) => question.field)).toEqual(['minutes'])

    const missing = buildClarifyPlan({
      kind: 'workout',
      workout: { type: '力量', exercises: [{ key: 'w1', exercise: '深蹲' }] }
    })
    expect(missing.questions[0].field).toBe('深蹲.sets')
    expect(missing.questions[0].blocking).toBe(true)
  })

  it('「不再追问」名单里的字段被拦下，只提示留空', () => {
    const plan = buildClarifyPlan({
      kind: 'intake',
      intake: [{ key: 'a', food: '盐' }],
      mutedFields: ['盐.grams']
    })
    expect(plan.questions).toHaveLength(0)
    expect(plan.muted).toEqual(['盐.grams'])
  })

  it('阻塞项排在前面', () => {
    const plan = buildClarifyPlan({
      kind: 'intake',
      intake: [{ key: 'a', food: '食用油', grams: 10, pending: false }]
    })
    expect(plan.questions.every((question) => !question.blocking)).toBe(true)
  })
})

describe('落库判据', () => {
  it('有克重、或明确说不记，都算已解决', () => {
    expect(isResolved(80, false)).toBe(true)
    expect(isResolved(undefined, false, '不记')).toBe(true)
    expect(isResolved(undefined, false, '共 20g')).toBe(true)
    expect(isResolved(undefined, false)).toBe(false)
    expect(isResolved(10, true)).toBe(false)
    expect(isResolved(10, true, '共 10g')).toBe(true)
    expect(isResolved(10, true, '不记')).toBe(true)
  })

  it('resolveGrams 用回答覆盖估算，「不记」则留空', () => {
    expect(resolveGrams({ grams: 5 })).toBe(5)
    expect(resolveGrams({ grams: undefined, answer: '共 20g' })).toBe(20)
    expect(resolveGrams({ grams: 10, answer: '不记' })).toBeUndefined()
    expect(resolveGrams({ grams: 10, answer: '随便' })).toBe(10)
  })

  it('油盐识别', () => {
    expect(isSeasoning('食用油')).toBe(true)
    expect(isSeasoning('生抽')).toBe(true)
    expect(isSeasoning('鸡蛋')).toBe(false)
  })
})
