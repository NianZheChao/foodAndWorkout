/** 契约六：`log.parse` —— 自由文本（可带图片）→ 可确认的结构化草稿（§6.11）。 */

import { z } from 'zod'
import type { LlmTask } from '../types'

export interface LogParseInput {
  date: string
  text: string
  /** 入口提示：在「记饮食」提交就传 intake，在「记训练」提交就传 workout（§6.11 kind 必须匹配入口） */
  expectedKind: 'intake' | 'workout'
  mealHint?: string
  /** 只给名称，让模型优先复用库里的标准名；不发送任何数值（DR-40） */
  knownFoods: string[]
  imageCount: number
}

const clarifyItem = z.object({
  field: z.string(),
  question: z.string(),
  options: z.array(z.string()).default([])
})

const assumptionItem = z.union([
  z.string(),
  z.object({ text: z.string() }).transform((value) => value.text)
])

const intakeItem = z.object({
  food: z.string(),
  amountText: z.string().default(''),
  grams: z.coerce.number().nullable().optional(),
  pending: z.boolean().default(false),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  cookedState: z.enum(['生', '熟', '市售']).optional()
})

const workoutItem = z.object({
  exercise: z.string(),
  sets: z.coerce.number().optional(),
  reps: z.coerce.number().optional(),
  weightKg: z.coerce.number().optional(),
  bodyweight: z.boolean().default(false)
})

const shared = {
  clarify: z.array(clarifyItem).default([]),
  assumptions: z.array(assumptionItem).default([]),
  uncertain: z.array(z.string()).default([]),
  rawText: z.string().default('')
}

export const intakeDraftSchema = z.object({
  kind: z.literal('intake'),
  meal: z.enum(['早餐', '午餐', '晚餐', '加餐']).default('午餐'),
  dish: z.string().default(''),
  items: z.array(intakeItem),
  ...shared
})

export const workoutDraftSchema = z.object({
  kind: z.literal('workout'),
  type: z.enum(['力量', '有氧', '球类', '拉伸', '其他']).default('力量'),
  minutes: z.coerce.number().optional(),
  rpe: z.coerce.number().optional(),
  items: z.array(workoutItem),
  ...shared
})

export const logParseSchema = z.discriminatedUnion('kind', [intakeDraftSchema, workoutDraftSchema])

export type LogParseOutput = z.infer<typeof logParseSchema>
export type IntakeDraftOutput = z.infer<typeof intakeDraftSchema>
export type WorkoutDraftOutput = z.infer<typeof workoutDraftSchema>

export const logParseTask: LlmTask<LogParseInput, LogParseOutput> = {
  id: 'log.parse',
  version: 1,
  title: '解析一句话/照片记录',
  systemPrompt:
    '你是饮食与训练记录的解析器，把用户的一句话拆成可确认的条目。只输出 JSON，不要解释。' +
    '饮食：按食材拆行，油、盐、糖、酱料必须单独成条；给出 grams（克），拿不准就填 null 并把 pending 设为 true；' +
    '熟重用 cookedState="熟"。训练：按动作拆行，给出 sets/reps/weightKg。' +
    '凡是「没量过、正常量、随便吃点」这类无法折算的，不要瞎猜，写进 clarify 逐条提问，并给 3-4 个可点选选项；' +
    '确实按常见基准估算的，写进 assumptions。' +
    '返回 {"kind":"intake|workout", ... 其余按各自字段，"clarify":[{"field":"食物.grams","question":"…","options":["…"]}],"assumptions":["…"],"uncertain":["…"],"rawText":"原文"}',
  buildPayload: (input) => ({
    date: input.date,
    text: input.text,
    expectedKind: input.expectedKind,
    mealHint: input.mealHint ?? null,
    knownFoods: input.knownFoods,
    imageCount: input.imageCount
  }),
  schema: logParseSchema,
  maxOutputTokens: 900
}
