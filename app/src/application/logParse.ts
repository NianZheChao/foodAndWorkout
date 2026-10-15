/**
 * `log.parse` 的应用层（FR-110 / FR-111 / §6.11）。
 *
 * 这是唯一允许把自然语言当输入的入口，也是唯一产出**草稿**而不是数据的入口（DR-48）。
 * 草稿不参与汇总，澄清答完并确认后才落库；模型失败也不能丢用户的原文。
 */

import { newId } from '@/data/repositories/intake'
import { putDraft } from '@/data/repositories/drafts'
import { enqueue, markOp } from '@/data/repositories/pendingOps'
import { getSettings } from '@/data/repositories/settings'
import { buildClarifyPlan, type ClarifyPlan } from '@/domain/clarify'
import { resolvePortion } from '@/domain/portion'
import { runTask, type RunFailure, type RunOptions } from '@/llm'
import {
  logParseTask,
  type IntakeDraftOutput,
  type LogParseOutput,
  type WorkoutDraftOutput
} from '@/llm/tasks/logParse'
import { findFoodFuzzy, suggestKnownFoods } from './foodLibrary'
import type { DraftIntakeItem, DraftKind, DraftRecord, DraftWorkoutItem, Meal } from '@/domain/types'

/** 单次请求最多带几张图（§6.11）。超过的部分本地截断并提示。 */
export const MAX_IMAGES = 3

export interface ParseLogInput {
  date: string
  text: string
  /** 入口意图：kind 必须匹配入口，不匹配时不静默改写（§6.11） */
  kind: DraftKind
  meal?: Meal
  /** 已压缩的 data URL；内容只存在于内存，不落库（FR-1417） */
  images?: string[]
  draftId?: string
}

export type ParseLogOutcome =
  | { status: 'ok'; draft: DraftRecord; plan: ClarifyPlan }
  | { status: 'kind-mismatch'; draft: DraftRecord; plan: ClarifyPlan; expected: DraftKind; actual: DraftKind }
  | { status: 'failed'; failure: RunFailure; draft: DraftRecord; queued: boolean }

export interface ParseLogBehavior {
  /**
   * 失败时是否写待办队列，默认写。队列重放时必须传 `false`，
   * 否则「重放失败 → 又排一条」会自增队列（§6.10）。
   */
  enqueueOnFailure?: boolean
}

interface MappedIntake {
  items: DraftIntakeItem[]
  assumptions: string[]
}

/**
 * 把模型的摄入条目转成草稿条目，并在本地能算的时候补上克数。
 *
 * 「模型没给克数」不等于「必须问」：如果库里已有这个食物、而且它登记了「1个 = 50g」这类
 * 常见基准，本地就能折算出来，直接填上并把依据写进 assumptions（§6.12 可估算类）。
 */
async function mapIntake(output: IntakeDraftOutput): Promise<MappedIntake> {
  const items: DraftIntakeItem[] = []
  const assumptions: string[] = []
  for (const [index, item] of output.items.entries()) {
    const draft: DraftIntakeItem = {
      key: `i${index}-${item.food}`,
      dish: output.dish,
      food: item.food,
      amountText: item.amountText ?? '',
      grams: item.grams ?? undefined,
      cookedState: item.cookedState,
      pending: item.pending,
      confidence: item.confidence
    }
    if (draft.grams === undefined && draft.amountText) {
      const food = await findFoodFuzzy(item.food)
      const resolved = food ? resolvePortion(draft.amountText, food) : undefined
      if (food && resolved?.grams !== undefined) {
        draft.grams = resolved.grams
        draft.pending = false
        assumptions.push(`「${item.amountText}」按「${food.name}」的常见份量折算为 ${resolved.grams}g`)
      }
    }
    items.push(draft)
  }
  return { items, assumptions }
}

function mapWorkout(output: WorkoutDraftOutput): DraftWorkoutItem[] {
  return output.items.map((item, index) => ({
    key: `w${index}-${item.exercise}`,
    exercise: item.exercise,
    sets: item.sets,
    reps: item.reps,
    weightKg: item.weightKg,
    bodyweight: item.bodyweight
  }))
}

function emptyDraft(input: ParseLogInput, id: string, now: number): DraftRecord {
  return {
    id,
    date: input.date,
    kind: input.kind,
    status: 'collecting',
    rawText: input.text,
    imageCount: (input.images ?? []).length,
    meal: input.meal ?? '午餐',
    dish: '',
    intake: [],
    workout: { type: '力量', exercises: [] },
    questions: [],
    assumptions: [],
    uncertain: [],
    createdAt: now,
    updatedAt: now
  }
}

export async function parseLog(
  input: ParseLogInput,
  options: RunOptions = {},
  behavior: ParseLogBehavior = {}
): Promise<ParseLogOutcome> {
  const id = input.draftId ?? newId('draft')
  const now = Date.now()
  const images = (input.images ?? []).slice(0, MAX_IMAGES)

  if (!input.text.trim() && !images.length) {
    return {
      status: 'failed',
      draft: emptyDraft(input, id, now),
      queued: false,
      failure: { ok: false, kind: 'bad-request', message: '先说一句吃了什么、练了什么，或者传张照片', retriable: false }
    }
  }

  const knownFoods = await suggestKnownFoods(input.text)
  const result = await runTask(
    logParseTask,
    {
      date: input.date,
      text: input.text,
      expectedKind: input.kind,
      mealHint: input.meal,
      knownFoods,
      imageCount: images.length
    },
    {
      ...options,
      extraUserParts: images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
    }
  )

  if (!result.ok) {
    // 原文先存下来：模型失败不等于用户的描述丢了（DR-44 / NFR-02）
    const draft = emptyDraft(input, id, now)
    draft.assumptions = ['这段时间的模型调用没成功，原文已留在草稿里，可以直接重试或手工录入']
    await putDraft(draft)
    const queued =
      behavior.enqueueOnFailure !== false && (result.retriable || result.kind === 'not-configured')
    if (queued) {
      const opId = await enqueue('log.parse', id)
      await markOp(opId, { status: 'waiting', lastError: result.message })
    }
    return { status: 'failed', failure: result, draft, queued }
  }

  const output: LogParseOutput = result.value
  const mapped = output.kind === 'intake' ? await mapIntake(output) : { items: [], assumptions: [] }
  const settings = await getSettings()

  const draft: DraftRecord = {
    id,
    date: input.date,
    kind: output.kind,
    status: 'collecting',
    rawText: output.rawText?.trim() || input.text,
    imageCount: images.length,
    meal: output.kind === 'intake' ? output.meal : (input.meal ?? '午餐'),
    dish: output.kind === 'intake' ? output.dish : '',
    intake: mapped.items,
    workout:
      output.kind === 'workout'
        ? {
            type: output.type,
            minutes: output.minutes,
            rpe: output.rpe,
            exercises: mapWorkout(output)
          }
        : { type: '力量', exercises: [] },
    questions: [],
    assumptions: [...mapped.assumptions, ...output.assumptions],
    uncertain: output.uncertain,
    model: result.model,
    taskVersion: logParseTask.version,
    createdAt: now,
    updatedAt: now
  }

  const plan = buildClarifyPlan({
    kind: draft.kind,
    intake: draft.intake,
    workout: draft.workout,
    modelQuestions: output.clarify,
    mutedFields: settings.mutedFields
  })
  draft.questions = plan.questions
  draft.status = plan.questions.some((question) => question.blocking) ? 'collecting' : 'ready'
  await putDraft(draft)

  if (output.kind !== input.kind) {
    return { status: 'kind-mismatch', draft, plan, expected: input.kind, actual: output.kind }
  }
  return { status: 'ok', draft, plan }
}
