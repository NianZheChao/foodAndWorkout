/**
 * 契约五：`calibration.review` —— 校准向导的 AI 复核（T3.5 / §6.7）。
 *
 * 输入 = 近 4 周的本地数字（实测 TDEE 与样本量、体重均线与变化率、平均摄入与达标率、
 * 当前目标、上次校准）+ **本地按同一套口径先算出来的建议**；输出只有「要不要动、动多少、为什么」。
 *
 * 两条纪律写死在提示词里：① 数字只能引用输入；② 幅度由本地门禁兜底（FR-904），
 * 提示词里也明说单次不许超过 ±150 kcal —— 但**不算数**，真正的拦截在 `domain/calibrationReview.ts`。
 */

import { z } from 'zod'
import type { LlmTask } from '../types'
import type { CalibrationReviewContent, CalibrationReviewInput } from '@/domain/calibrationReview'

const calibrationContentSchema = z.object({
  recommended: z.boolean(),
  // 模型常把幅度写成字符串（"-120"），用 coerce 收下，避免无谓的 Zod 重试
  deltaKcal: z.coerce.number(),
  direction: z.enum(['上调', '下调', '不变']),
  confidence: z.enum(['low', 'medium', 'high']),
  rationale: z.string(),
  watchItems: z.array(z.string())
}) satisfies z.ZodType<CalibrationReviewContent>

/** 输入字段本身就是白名单，原样进 payload（DR-40：禁止把原始记录直接序列化）。 */
function buildCalibrationPayload(input: CalibrationReviewInput): unknown {
  return input
}

const SYSTEM_PROMPT =
  // 小写 `json` 是 DeepSeek JSON 模式的硬要求（缺了会返回空正文）
  '你是减脂增肌教练 assistant，只输出 json（JSON），不要解释、不要 Markdown。' +
  '输入里有实测 TDEE、体重均线与变化率、平均摄入与达标率、当前目标，以及本地先算好的一条建议。' +
  '所有数字只能引用输入里已有的数，禁止自己计算或估计；输入里没有的数就不要给。' +
  'recommended 表示要不要现在调整热量目标；deltaKcal 是相对输入 currentTargets.kcalTarget 的建议调整量，' +
  '单次幅度不许超过 ±150 kcal（超过会被本地门禁拦下、作废）；不想调整就填 0 并把 recommended 设为 false。' +
  'direction 必须是「上调」「下调」「不变」之一，且与 deltaKcal 的符号一致。' +
  'confidence 用 low / medium / high：样本少（TDEE 天数少、记录覆盖率低）就写 low。' +
  'rationale 一两句说明理由；watchItems 是接下来该盯的 1-3 件事（例如体重均线、蛋白达标）。' +
  '输出 {"recommended":false,"deltaKcal":0,"direction":"不变","confidence":"medium","rationale":"","watchItems":[]}。'

export const calibrationReviewTask: LlmTask<CalibrationReviewInput, CalibrationReviewContent> = {
  id: 'calibration.review',
  version: 1,
  title: '生成校准建议',
  systemPrompt: SYSTEM_PROMPT,
  buildPayload: buildCalibrationPayload,
  schema: calibrationContentSchema,
  maxOutputTokens: 500
}
