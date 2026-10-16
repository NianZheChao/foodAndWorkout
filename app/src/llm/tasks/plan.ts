/**
 * 契约三 / 契约四：`plan.training` 与 `plan.meal`（B 级，T3.8 / §6.5 / §6.6）。
 *
 * 这两个是**唯一会给出具体清单**的任务（练哪几个动作、吃哪几样各多少克），所以：
 * - 输入是**本地摘要**：缺口、近 14 天的肌群账、上次同动作的写法、档案里的四项约束 ——
 *   没有一条原始记录、不问「家里还有什么」（FR-803 / FR-805）；
 * - 输出的**数字一律本地复算**（FR-806）：食材克数按食物库重算，时长按组数重算，
 *   模型自报的合计只用来比对；
 * - 两处安全边界在提示词里写明，但**真正算数的是 `domain/plan.ts`**：
 *   器材白名单与 +10% 加重提示。
 *
 * 开关默认关，而且四项约束没齐就打不开（FR-1003）；门禁在 `application/plan.ts` 再判一次。
 */

import { z } from 'zod'
import type { LlmTask } from '../types'
import type { PlanMealOutput, PlanTrainingOutput } from '@/domain/plan'

/* ------------------------------ plan.training ------------------------------ */

export interface PlanTrainingInput {
  date: string
  /** 今天的缺口与状态（与每日指导同源） */
  today: {
    kcalSoFar: number
    proteinSoFarG: number
    remainingKcal?: number
    remainingProteinG: number | undefined
    trainedToday: boolean
    weightAmKg?: number
  }
  /** 近 14 天的肌群账（本地算好；`hoursSinceLast` 是「恢复优先」的判据） */
  muscles: { muscle: string; sets: number; hoursSinceLast?: number }[]
  /** 目标：每个肌群每周组数下限、每周训练天数 */
  targets: { setsPerMuscle: number; trainingDays: number }
  /** 每个动作最近一次的写法（渐进超负荷的参照） */
  recent: { exercise: string; date: string; volume: string }[]
  /** 档案里的四项约束（忌口 / 过敏 / 可用器材 / 每餐时间），缺项写「未填」 */
  constraints: string[]
  /** 本地先算好的事实：48 小时内练过、还没恢复的肌群 */
  needsRecovery: string[]
}

const trainingSchema = z.object({
  focus: z.string(),
  estimatedMinutes: z.coerce.number(),
  exercises: z.array(
    z.object({
      name: z.string(),
      muscles: z.array(z.string()),
      sets: z.coerce.number(),
      reps: z.coerce.number(),
      weightKg: z.coerce.number().optional(),
      rpe: z.coerce.number().optional(),
      // 器材是本地白名单校验的输入（§6.5）：不给就没法核对，提示词里要求必填
      equipment: z.array(z.string()).optional(),
      progression: z.string().optional(),
      reason: z.string()
    })
  ),
  notes: z.array(z.string())
}) satisfies z.ZodType<PlanTrainingOutput>

/** 输入字段本身就是白名单，原样进 payload（DR-40：禁止把原始记录直接序列化）。 */
function buildTrainingPayload(input: PlanTrainingInput): unknown {
  return input
}

const TRAINING_PROMPT =
  // 小写 `json` 是 DeepSeek JSON 模式的硬要求（缺了会返回空正文）
  '你是减脂增肌教练 assistant，只输出 json（JSON），不要解释、不要 Markdown。' +
  '按这个优先级排今天的训练：① 48 小时内练过的肌群先排除（输入里的 needsRecovery）；' +
  '② 补欠账最多的肌群（muscles 里组数离 targets.setsPerMuscle 最远的）；' +
  '③ 给具体的渐进（比输入 recent 里同动作的重量 +2.5kg，或加 1-2 次）；' +
  '④ 只用 constraints 里「可用器材」那一项写着的器材，做不到就给替代动作；' +
  '⑤ 4-6 个动作、每个 3-4 组，总组数与「每餐时间」对不上就减动作。' +
  '每个动作都要写 equipment（用到的一件件器材，自重写「自重」）、reason（为什么是它，' +
  '要引用输入里的数：欠了多少组、上次练的重量）、progression（怎么加）。' +
  '所有数字只能引用输入里已有的数，禁止自己计算或估计。不要把拉伸算进力量动作。' +
  'focus 是一句话重点；notes 是 0-3 条注意事项。' +
  '输出 {"focus":"","estimatedMinutes":0,"exercises":[{"name":"","muscles":[],"sets":0,"reps":0,' +
  '"weightKg":0,"rpe":0,"equipment":[],"progression":"","reason":""}],"notes":[]}。'

export const planTrainingTask: LlmTask<PlanTrainingInput, PlanTrainingOutput> = {
  id: 'plan.training',
  version: 1,
  title: '生成今天的训练计划',
  systemPrompt: TRAINING_PROMPT,
  buildPayload: buildTrainingPayload,
  schema: trainingSchema,
  // FR-1413：推荐类 ≤600 输出
  // FR-1413：推荐 ≤800 输入
  inputBudget: 800,
  maxOutputTokens: 600
}

/* -------------------------------- plan.meal -------------------------------- */

export interface PlanMealInput {
  date: string
  /** 缺口：还差多少热量与蛋白、钠到没到上限、纤维还缺多少 */
  gap: {
    remainingKcal?: number
    remainingProteinG?: number
    sodiumMaxMg?: number
    sodiumSoFarMg?: number
    sodiumOverLimit: boolean
    fiberTargetG?: number
    fiberSoFarG?: number
  }
  /** 档案里的四项约束（含忌口 / 过敏，这是「不能吃什么」的唯一来源） */
  constraints: string[]
  /** 常用食材名（**只有名称**，不给数值；FR-805 / DR-40） */
  commonFoods: string[]
}

const mealSchema = z.object({
  title: z.string(),
  items: z.array(z.object({ food: z.string(), grams: z.coerce.number(), dish: z.string().optional() })),
  seasonings: z
    .array(z.object({ food: z.string(), grams: z.coerce.number(), dish: z.string().optional() }))
    .optional(),
  totalsPreview: z
    .object({
      kcal: z.coerce.number(),
      proteinG: z.coerce.number(),
      fatG: z.coerce.number(),
      carbG: z.coerce.number()
    })
    .optional(),
  shoppingList: z
    .array(z.object({ item: z.string(), amount: z.string(), substitute: z.string().optional() }))
    .optional()
}) satisfies z.ZodType<PlanMealOutput>

function buildMealPayload(input: PlanMealInput): unknown {
  return input
}

const MEAL_PROMPT =
  '你是减脂增肌教练 assistant，只输出 json（JSON），不要解释、不要 Markdown。' +
  '先看 gap：优先把剩下的蛋白补上，其次把热量补到还差的那一档；sodiumOverLimit 为 true 时' +
  '不要用腌制品、酱料、加工肉；纤维还缺就多给蔬菜或全谷。' +
  '严格避开 constraints 里「忌口」与「过敏」的食材，永远不要推荐它们，也不要推荐它们的近亲替代。' +
  '只用 constraints 里「可用器材」写着的厨具能做的做法；每餐时间决定方案的复杂度。' +
  '给 1-2 样主料、2-4 个食材行，逐行写 food（尽量用 commonFoods 里已有的名字，' +
  '这样本地库能算得准）与 grams（生重克数，整数）。seasonings 单独列油盐酱醋。' +
  'totalsPreview 是你自己按常识估的四项合计（本地会重算并可能覆盖它）。' +
  '确实缺料时 shoppingList 写买什么、买多少，并给 substitute（不买也能做的替代）。' +
  '所有数字自己算不清楚就写 0，不要编造库里的数值。' +
  '输出 {"title":"","items":[{"food":"","grams":0,"dish":""}],"seasonings":[{"food":"","grams":0}],' +
  '"totalsPreview":{"kcal":0,"proteinG":0,"fatG":0,"carbG":0},' +
  '"shoppingList":[{"item":"","amount":"","substitute":""}]}。'

export const planMealTask: LlmTask<PlanMealInput, PlanMealOutput> = {
  id: 'plan.meal',
  version: 1,
  title: '生成今天还能吃什么',
  systemPrompt: MEAL_PROMPT,
  buildPayload: buildMealPayload,
  schema: mealSchema,
  // FR-1413：推荐 ≤800 输入
  inputBudget: 800,
  maxOutputTokens: 600
}