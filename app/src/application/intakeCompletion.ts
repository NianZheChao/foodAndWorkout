/**
 * 补齐一条待补全的摄入记录（FR-506）。
 *
 * 记录页只负责收集输入；这里负责：重新读一次最新记录（防止队列刚刚补过）、
 * 走 `domain/intakeCompletion` 的本地校验与换算、落库前拍一张当天快照。
 */

import { captureDay } from '@/application/snapshot'
import { getIntake, updateIntake } from '@/data/repositories/intake'
import {
  reviewIntakeCompletion,
  type IntakeCompletionInput,
  type IntakeCompletionReview
} from '@/domain/intakeCompletion'
import type { Amount, NutritionFacts } from '@/domain/types'

export type CompleteIntakeResult =
  | { ok: true; warnings: string[]; amount: Amount; computed: NutritionFacts }
  | { ok: false; error: string }

export async function completePendingIntake(
  entryId: string,
  input: IntakeCompletionInput
): Promise<CompleteIntakeResult> {
  const entry = await getIntake(entryId)
  if (!entry) return { ok: false, error: '这条记录已经不在了，刷新后再试' }
  if (entry.pendingFlag !== 1) return { ok: false, error: '这条记录已经补全过了，刷新后会显示最新数值' }

  const review: IntakeCompletionReview = reviewIntakeCompletion(entry, input)
  if (!review.ok || !review.amount || !review.computed || !review.foodSnapshot) {
    return { ok: false, error: review.error ?? '这条还没补齐，检查一下份量或营养值' }
  }

  await captureDay(entry.date, '补齐摄入条目前的自动快照')
  await updateIntake(entry.id, {
    foodId: review.foodId,
    foodSnapshot: review.foodSnapshot,
    amount: review.amount,
    computed: review.computed,
    pendingFlag: 0
  })

  return {
    ok: true,
    warnings: review.warnings,
    amount: review.amount,
    computed: review.computed
  }
}
