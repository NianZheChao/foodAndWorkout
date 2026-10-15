/** 契约一：`food.resolve` —— 解析库里没有的食物营养（§6.3 / FR-403 / FR-404）。 */

import { z } from 'zod'
import type { LlmTask } from '../types'

export interface FoodResolveInput {
  items: { text: string; portionHint?: string }[]
}

const resolvedItem = z.object({
  query: z.string(),
  matched: z.boolean(),
  name: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  kcal: z.coerce.number().optional(),
  protein_g: z.coerce.number().optional(),
  fat_g: z.coerce.number().optional(),
  carb_g: z.coerce.number().optional(),
  fiber_g: z.coerce.number().optional(),
  sodium_mg: z.coerce.number().optional(),
  cooked_state: z.enum(['生', '熟', '市售']).optional(),
  edible_note: z.string().optional(),
  portions: z.array(z.object({ label: z.string(), grams: z.coerce.number() })).optional(),
  source_note: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional()
})

export const foodResolveSchema = z.object({ items: z.array(resolvedItem) })

export type FoodResolveOutput = z.infer<typeof foodResolveSchema>
export type ResolvedFoodItem = z.infer<typeof resolvedItem>

export const foodResolveTask: LlmTask<FoodResolveInput, FoodResolveOutput> = {
  id: 'food.resolve',
  version: 1,
  title: '解析食物营养',
  systemPrompt:
    '你是中国食物成分数据助手。只输出 JSON，不要解释、不要 Markdown。每项按可食部每 100g（液体每 100ml）给出 kcal、protein_g、fat_g、carb_g、fiber_g、sodium_mg，取值贴近中国食物成分表。' +
    '拿不准就降低 confidence；查不到就把 matched 设为 false，绝不编造。' +
    '返回 {"items":[{"query":"原样回填输入文本","matched":true,"name":"规范名","category":"分类","unit":"100g","kcal":0,"protein_g":0,"fat_g":0,"carb_g":0,"fiber_g":0,"sodium_mg":0,"cooked_state":"生|熟|市售","edible_note":"","portions":[{"label":"1个","grams":50}],"source_note":"","confidence":"high|medium|low"}]}',
  buildPayload: (input) => ({
    items: input.items.map((item) => ({ text: item.text, portionHint: item.portionHint ?? null }))
  }),
  schema: foodResolveSchema,
  // 10 条一起问时 300 tokens 装不下，按条目数放大并封顶（§6.9 的 300 是单条基线）
  maxOutputTokens: (input) => Math.min(1200, 140 * input.items.length + 60)
}
