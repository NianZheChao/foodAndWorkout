/**
 * 草稿会话（§6.11 / §6.12）。
 *
 * 草稿是「还没确认的数据」：不参与当日汇总，澄清答完并由用户点确认后才落成
 * `IntakeEntry` / `WorkoutEntry`（DR-48）。所有回答都按**字段 id** 存，
 * 这样「一个问题答一次」天然成立，也不会因为重新渲染而丢答案。
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { deleteDraft, listOpenDrafts, putDraft } from '@/data/repositories/drafts'
import { parseLog } from '@/application/logParse'
import { persistCandidate, resolveFoods } from '@/application/foodResolve'
import { findFoodFuzzy } from '@/application/foodLibrary'
import { resolveGrams } from '@/domain/clarify'
import { factsForGrams } from '@/domain/nutrition'
import { inferMusclesFromExercise } from '@/domain/training'
import type { RunOptions } from '@/llm'
import type { useDayStore } from './day'
import type { DraftKind, DraftRecord, Food, Meal, NutritionFacts, WorkoutSet } from '@/domain/types'

export interface DraftIntakeRow {
  key: string
  food: string
  amountText: string
  grams?: number
  foodMatch?: Food
  facts?: NutritionFacts
  /** 克重（或数值）没齐，暂时算不出：落库时留待补全，不阻塞记录（FR-506） */
  blocked: boolean
  reason?: string
}

export interface DraftWorkoutRow {
  key: string
  exercise: string
  sets: number
  reps?: number
  weightKg?: number
  bodyweight: boolean
  load: number
  blocked: boolean
}

export const useDraftStore = defineStore('draft', () => {
  const draft = shallowRef<DraftRecord>()
  const answers = ref<Record<string, string>>({})
  const busy = ref(false)
  const error = ref<string>()
  const notices = ref<string[]>([])
  const mismatch = ref<{ expected: DraftKind; actual: DraftKind }>()
  const committed = ref(false)

  const questions = computed(() => draft.value?.questions ?? [])
  const openQuestions = computed(() => questions.value.filter((question) => !answers.value[question.field]))
  const blockedQuestions = computed(() => openQuestions.value.filter((question) => question.blocking))
  const hasDraft = computed(() => !!draft.value && draft.value.status !== 'committed' && draft.value.status !== 'discarded')

  function reset(): void {
    draft.value = undefined
    answers.value = {}
    error.value = undefined
    notices.value = []
    mismatch.value = undefined
    committed.value = false
  }

  /** 提交一段描述（可带图片）→ 草稿 + 澄清清单。 */
  async function submit(
    input: { date: string; text: string; kind: DraftKind; meal?: Meal; images?: string[] },
    options: RunOptions = {}
  ): Promise<'ok' | 'kind-mismatch' | 'failed'> {
    busy.value = true
    error.value = undefined
    notices.value = []
    mismatch.value = undefined
    committed.value = false
    try {
      const outcome = await parseLog(input, options)
      draft.value = outcome.draft
      answers.value = {}
      if (outcome.status === 'failed') {
        error.value = outcome.failure.message
        if (outcome.queued) notices.value.push('已放进待办队列，等模型可用时会自动重试')
        return 'failed'
      }
      if (outcome.status === 'kind-mismatch') {
        mismatch.value = { expected: outcome.expected, actual: outcome.actual }
        return 'kind-mismatch'
      }
      return 'ok'
    } finally {
      busy.value = false
    }
  }

  /** 用户选择按哪一种记：只是采用模型给的 kind，绝不静默改写（§6.11）。 */
  async function adoptKind(kind: DraftKind): Promise<void> {
    if (!draft.value) return
    draft.value = { ...draft.value, kind, updatedAt: Date.now() }
    mismatch.value = undefined
    await putDraft(draft.value)
  }

  function answer(field: string, value: string): void {
    answers.value = { ...answers.value, [field]: value }
  }

  function answerFor(field: string): string | undefined {
    return answers.value[field]
  }

  async function resolvedIntake(): Promise<DraftIntakeRow[]> {
    const current = draft.value
    if (!current) return []
    const rows: DraftIntakeRow[] = []
    for (const item of current.intake) {
      const answered = answers.value[`${item.food}.grams`]
      const grams = resolveGrams({ grams: item.grams, answer: answered })
      const food = await findFoodFuzzy(item.food)
      const facts = food && grams !== undefined ? factsForGrams(food, grams) : undefined
      rows.push({
        key: item.key,
        food: item.food,
        amountText: item.amountText,
        grams,
        foodMatch: food,
        facts,
        blocked: grams === undefined || !facts,
        reason: grams === undefined ? '克重还没定' : food ? undefined : '食物库还没有它的数值'
      })
    }
    return rows
  }

  function resolvedWorkout(): DraftWorkoutRow[] {
    const workout = draft.value?.workout
    if (!workout) return []
    return workout.exercises.map((item) => ({
      key: item.key,
      exercise: item.exercise,
      sets: item.sets ?? 1,
      reps: item.reps,
      weightKg: item.weightKg,
      bodyweight: item.bodyweight,
      load: item.bodyweight || !item.weightKg ? 0 : (item.sets ?? 1) * (item.reps ?? 0) * item.weightKg,
      blocked: item.sets === undefined || item.reps === undefined
    }))
  }

  /** 落库：逐条走「库内命中 → 模型解析 → 仍然没有就留待补全」，全程不阻塞（DR-44）。 */
  async function commit(day: ReturnType<typeof useDayStore>): Promise<void> {
    const current = draft.value
    if (!current) return
    busy.value = true
    error.value = undefined
    notices.value = []
    try {
      if (current.kind === 'intake') {
        const rows = await resolvedIntake()
        for (const row of rows) {
          let food = row.foodMatch
          if (!food) {
            const outcome = await resolveFoods([row.food])
            const candidate = outcome.candidates[0]
            if (candidate?.food && candidate.matched) food = await persistCandidate(candidate.food)
          }
          const facts = food && row.grams !== undefined ? factsForGrams(food, row.grams) : undefined
          const pending = !food || !facts
          const snapshot = food ?? {
            name: row.food,
            unit: '100g',
            kcal: 0,
            proteinG: 0,
            fatG: 0,
            carbG: 0,
            fiberG: 0,
            sodiumMg: 0
          }
          const id = await day.addFoodEntry({
            meal: current.meal,
            dish: current.dish || row.food,
            food: snapshot,
            amount: {
              qty: 1,
              unit: row.grams !== undefined ? `${row.grams}g` : row.amountText || '待补全',
              grams: row.grams
            },
            computed: facts ?? { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 },
            note: current.rawText
          })
          if (pending) {
            await day.markPending(id, true)
            notices.value.push(`「${row.food}」缺数值，先记为待补全，补齐后会自动重算`)
          }
        }
      } else {
        const rows = resolvedWorkout()
        for (const [index, row] of rows.entries()) {
          const sets: WorkoutSet[] = Array.from({ length: Math.max(1, row.sets) }, () => ({
            reps: row.reps ?? 0,
            weightKg: row.weightKg,
            bodyweight: row.bodyweight || row.weightKg === undefined
          }))
          await day.addWorkoutEntry({
            type: current.workout.type,
            // 时长只写在第一条上，避免多动作时被重复累加
            minutes: index === 0 ? current.workout.minutes : undefined,
            rpe: index === 0 ? current.workout.rpe : undefined,
            muscles: inferMusclesFromExercise(row.exercise),
            exercise: row.exercise,
            sets,
            volumeRaw: row.weightKg ? `${row.sets}x${row.reps ?? 0}x${row.weightKg}kg` : `${row.sets}x${row.reps ?? 0}`
          })
        }
      }
      draft.value = { ...current, status: 'committed', updatedAt: Date.now() }
      committed.value = true
      await deleteDraft(current.id)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      busy.value = false
    }
  }

  async function discard(): Promise<void> {
    const current = draft.value
    if (!current) return
    await deleteDraft(current.id)
    reset()
  }

  /** 有未完成的草稿时接着答（草稿可以跨会话接着填）。 */
  async function loadOpen(date: string): Promise<void> {
    const open = await listOpenDrafts(date)
    if (!open.length) return
    draft.value = open[0]
  }

  return {
    draft,
    answers,
    busy,
    error,
    notices,
    mismatch,
    committed,
    questions,
    openQuestions,
    blockedQuestions,
    hasDraft,
    submit,
    adoptKind,
    answer,
    answerFor,
    resolvedIntake,
    resolvedWorkout,
    commit,
    discard,
    loadOpen,
    reset
  }
})
