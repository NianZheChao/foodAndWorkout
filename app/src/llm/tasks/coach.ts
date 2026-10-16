/**
 * 契约七：`coach.daily` —— 当天的诊断型指导（T3.7 / §6.4.2，A 级 P0）。
 *
 * 输出**不是**食谱或动作清单（那是默认关的 B 级 `plan.*`），而是「该往哪使劲」：
 * 一句话结论 + 带依据的判断 + 今天要做的 1-3 件事 + 还缺的信息。
 *
 * 输入 = 摘要 v2（近 7 天滚动窗口）+ 当日缺口 + 用户表过态的历史建议，
 * **不含任何原始记录**；每条建议的 `basis` 之后还要在本地过一遍依据校验（`domain/coach.ts`）。
 */

import { z } from 'zod'
import type { LlmTask } from '../types'
import type { CoachHistoryAdvice } from '@/domain/coach'
import type { CoachContent, CoachTodayGap, ReportDigest } from '@/domain/types'

const coachContentSchema = z.object({
  headline: z.string(),
  // basis 缺失（没标依据）会让整份输出不合规：依据是 A 级指导的底线（NFR-13），不能"忘了写"
  advice: z.array(
    z.object({
      kind: z.enum(['fact', 'inference']),
      text: z.string(),
      basis: z.array(z.string())
    })
  ),
  focus: z.array(z.string()),
  ask: z.array(z.string()),
  disclaimer: z.string()
}) satisfies z.ZodType<CoachContent>

export interface CoachTaskInput {
  date: string
  digest: ReportDigest
  today: CoachTodayGap
  history: { advice: CoachHistoryAdvice[] }
}

/** 输入字段本身就是白名单，原样进 payload（DR-40：禁止把原始对象直接序列化）。 */
function buildCoachPayload(input: CoachTaskInput): unknown {
  return input
}

const SYSTEM_PROMPT =
  // 小写 `json` 是 DeepSeek JSON 模式的硬要求（缺了会返回空正文）
  '你是减脂增肌教练 assistant，只输出 json（JSON），不要解释、不要 Markdown。' +
  '所有数字只能引用输入里已有的数，禁止自己计算或估计；输入里没有的数就不要给。' +
  'advice 每条都要给 basis：输入里的字段路径（摘要字段直接写路径，如 intake.avgProteinG；' +
  '当日缺口写 today.remainingProteinG），写不出依据的条目不要出现。' +
  '每条 advice 标 kind：fact=输入里能直接看到的，inference=你的推断。' +
  '只说该往哪使劲：不要给食谱、不要排训练动作与组次。' +
  'recovery 块带"有几天记录"，样本少就直说样本不足；不要自造达标线。' +
  'focus 是要做的 1-3 件事，按优先级；ask 是还缺的信息（例如今天还练不练）。' +
  '输出 {"headline":"","advice":[{"kind":"fact","text":"","basis":[]}],"focus":[],"ask":[],"disclaimer":""}。'

export const coachDailyTask: LlmTask<CoachTaskInput, CoachContent> = {
  id: 'coach.daily',
  version: 1,
  title: '生成今日指导',
  systemPrompt: SYSTEM_PROMPT,
  buildPayload: buildCoachPayload,
  schema: coachContentSchema,
  maxOutputTokens: 600
}
