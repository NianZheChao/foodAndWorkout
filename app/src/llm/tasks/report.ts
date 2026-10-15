/**
 * 契约二：`report.weekly` / `report.monthly` —— 把本地摘要写成结论（§6.4 / FR-701 / FR-702）。
 *
 * 两个任务共用一套输入输出契约，只有 `period.type` 与提示词里的措辞不同（月报多一段
 * 「与上月对比」）。**输入不含任何原始记录**，模型只能引用摘要里的数字 —— 引用错的地方
 * 由 `domain/reportGuard.ts` 标出来。
 */

import { z } from 'zod'
import type { LlmTask } from '../types'
import type { ReportContent, ReportDigest, ReportType } from '@/domain/types'

const reportContentSchema = z.object({
  summary: z.string(),
  training: z.object({ assessment: z.string(), notes: z.array(z.string()) }),
  diet: z.object({ assessment: z.string(), notes: z.array(z.string()) }),
  recovery: z.object({ notes: z.array(z.string()) }),
  // kind 缺失（模型漏标事实 / 推断）会让整份报告不合规，走 Zod 重试（FR-706）
  findings: z.array(
    z.object({
      kind: z.enum(['fact', 'inference']),
      text: z.string()
    })
  ),
  issues: z.array(z.string()),
  actions: z.array(z.string()),
  calibration: z.object({
    recommended: z.boolean(),
    deltaKcal: z.coerce.number(),
    rationale: z.string()
  }),
  disclaimer: z.string()
}) satisfies z.ZodType<ReportContent>

export interface ReportTaskInput {
  type: ReportType
  digest: ReportDigest
}

/** 摘要原样进 payload：字段本身就是白名单，不再额外裁剪（DR-40）。 */
function buildReportPayload(input: ReportTaskInput): unknown {
  return input.digest
}

const SHARED_PROMPT =
  '你是减脂增肌教练 assistant，只输出 JSON，不要解释、不要 Markdown。' +
  '所有数字只能来自输入摘要，禁止自己计算或估计任何数值；摘要里没有的数就先不给数。' +
  'findings 每条必须标 kind：fact=摘要里能直接看到的，inference=你的推断。' +
  'calibration.recommended 只在有把握且幅度合理时为 true，deltaKcal 是相对当前热量目标的建议调整量。' +
  '输出 {"summary":"","training":{"assessment":"","notes":[]},"diet":{"assessment":"","notes":[]},' +
  '"recovery":{"notes":[]},"findings":[{"kind":"fact","text":""}],"issues":[],"actions":[],' +
  '"calibration":{"recommended":false,"deltaKcal":0,"rationale":""},"disclaimer":""}。'

function makeReportTask(type: ReportType): LlmTask<ReportTaskInput, ReportContent> {
  const scope = type === 'weekly' ? '这一周' : '这个月'
  return {
    id: type === 'weekly' ? 'report.weekly' : 'report.monthly',
    version: 1,
    title: type === 'weekly' ? '生成周报结论' : '生成月报结论',
    systemPrompt: `${SHARED_PROMPT}你要写的是${scope}的复盘：训练、饮食、恢复各一两句，再给可执行的动作。`,
    buildPayload: buildReportPayload,
    schema: reportContentSchema,
    maxOutputTokens: type === 'weekly' ? 900 : 1200
  }
}

export const reportWeeklyTask = makeReportTask('weekly')
export const reportMonthlyTask = makeReportTask('monthly')

export function reportTaskFor(type: ReportType): LlmTask<ReportTaskInput, ReportContent> {
  return type === 'weekly' ? reportWeeklyTask : reportMonthlyTask
}
