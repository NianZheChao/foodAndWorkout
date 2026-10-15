/**
 * 澄清引擎（§6.12 / DR-47）。
 *
 * 目标是把「估不准」变成「问一句」，而不是「随便填一个数」。判据只有一条：
 * **这个字段缺了还能不能算**——算不了就是 `blocking`，必须问；算得了就估并写进假设。
 *
 * 问题 id 统一用 `<条目>.<字段>`（如 `面条(干).grams`），这样模型自带的 `clarify[]`
 * 能和本地补检出的缺失项按同一个 key 去重，同一个字段只会问一次。
 */

import { DEFAULT_PORTION_GRAMS, parsePortionInput, parseQuantity } from './portion'
import type { WorkoutType } from './types'

export type CookedState = '生' | '熟' | '市售'

export interface ClarifyQuestion {
  field: string
  question: string
  options: string[]
  /** true = 无值即无法计算，会阻塞该条目落库 */
  blocking: boolean
  source: 'model' | 'local'
}

export interface ClarifyIntakeItem {
  key: string
  food: string
  amountText?: string
  grams?: number
  pending?: boolean
}

export interface ClarifyWorkoutItem {
  key: string
  exercise: string
  sets?: number
  reps?: number
  weightKg?: number
  bodyweight?: boolean
}

export interface BuildClarifyInput {
  kind: 'intake' | 'workout'
  intake?: ClarifyIntakeItem[]
  workout?: { type: WorkoutType; minutes?: number; exercises: ClarifyWorkoutItem[] }
  /** 模型自带的提问（优先复用它的措辞） */
  modelQuestions?: { field: string; question: string; options?: string[] }[]
  /** 「不再追问」名单（FR-1103） */
  mutedFields?: string[]
}

export interface ClarifyPlan {
  questions: ClarifyQuestion[]
  /** 被「不再追问」拦下、但确实是必需项的字段：只提示留空，不再追问 */
  muted: string[]
}

/** 常见油盐类：必须单独成条并默认进澄清清单（DR-15）。 */
const SEASONING_RE = /油|盐|糖|酱|醋|料酒|味精|鸡精|胡椒|孜然|辣椒|豆瓣|生抽|老抽|味极鲜|腐乳|沙茶|拌饭酱/

export function isSeasoning(name: string): boolean {
  return SEASONING_RE.test(name)
}

function round10(value: number): number {
  return Math.round(value / 10) * 10
}

/** 克重问题的可点选选项：能从「4个」这类写法推出常见基准时给具体数字。 */
function gramOptions(item: ClarifyIntakeItem): string[] {
  const parsed = item.amountText ? parsePortionInput(item.amountText) : undefined
  const perUnit = parsed?.explicitGrams ?? (parsed ? DEFAULT_PORTION_GRAMS[parsed.unit] : undefined)
  if (parsed && perUnit) {
    const total = Math.round(parsed.qty * perUnit)
    return [`共 ${total}g`, `共 ${round10(total * 1.3)}g`, `共 ${round10(total * 0.7)}g`, '记不清']
  }
  if (item.grams !== undefined) {
    return [`共 ${Math.round(item.grams)}g`, `共 ${round10(item.grams * 1.5)}g`, '记不清']
  }
  return ['共 100g', '共 150g', '共 200g', '记不清']
}

function intakeQuestion(item: ClarifyIntakeItem): ClarifyQuestion | undefined {
  if (item.grams !== undefined && !item.pending) return undefined
  const label = item.food
  const confirm = item.grams !== undefined && item.pending
  return {
    field: `${label}.grams`,
    question: confirm
      ? `${label} 先按 ${Math.round(item.grams as number)}g 记，对吗？`
      : `${label}${item.amountText ? `（${item.amountText}）` : ''}大概是多少克？`,
    options: gramOptions(item),
    blocking: true,
    source: 'local'
  }
}

function workoutQuestions(workout: NonNullable<BuildClarifyInput['workout']>): ClarifyQuestion[] {
  const questions: ClarifyQuestion[] = []
  if (workout.type !== '力量' && workout.minutes === undefined) {
    questions.push({
      field: 'minutes',
      question: `${workout.type}练了多久？`,
      options: ['20 分钟', '30 分钟', '45 分钟', '60 分钟', '记不清'],
      blocking: true,
      source: 'local'
    })
  }
  for (const item of workout.exercises) {
    const missing: string[] = []
    if (item.sets === undefined) missing.push('几组')
    if (item.reps === undefined) missing.push('每组几次')
    if (!item.bodyweight && item.weightKg === undefined) missing.push('多重')
    if (missing.length) {
      questions.push({
        field: `${item.exercise}.sets`,
        question: `${item.exercise}缺「${missing.join(' / ')}」，补一下？`,
        options: ['3组 x 10次', '4组 x 8次', '自重组 x 12次', '记不清'],
        blocking: true,
        source: 'local'
      })
    }
  }
  return questions
}

/** 把模型提问与本地补检的缺失项合并成一张卡片：同字段只问一次，阻塞项排前面。 */
export function buildClarifyPlan(input: BuildClarifyInput): ClarifyPlan {
  const mutedFields = input.mutedFields ?? []
  const local: ClarifyQuestion[] = []

  if (input.kind === 'intake') {
    for (const item of input.intake ?? []) {
      const question = intakeQuestion(item)
      if (question) local.push(question)
    }
    // 油盐类即便给了克重也默认问一次：它最容易被漏、也最容易改变结论
    for (const item of input.intake ?? []) {
      if (!isSeasoning(item.food)) continue
      if (local.some((question) => question.field === `${item.food}.grams`)) continue
      local.push({
        field: `${item.food}.grams`,
        question: `${item.food}用了多少？（油盐单列才准）`,
        options: ['5g', '10g', '15g', '不记'],
        blocking: false,
        source: 'local'
      })
    }
  } else if (input.workout) {
    local.push(...workoutQuestions(input.workout))
  }

  const merged: ClarifyQuestion[] = []
  const seen = new Set<string>()
  for (const question of input.modelQuestions ?? []) {
    if (!question.field || seen.has(question.field)) continue
    seen.add(question.field)
    merged.push({
      field: question.field,
      question: question.question,
      options: question.options?.length ? question.options : ['记不清'],
      blocking: true,
      source: 'model'
    })
  }
  for (const question of local) {
    if (seen.has(question.field)) continue
    seen.add(question.field)
    merged.push(question)
  }

  const muted: string[] = []
  const questions = merged.filter((question) => {
    if (!mutedFields.includes(question.field) && !mutedFields.includes(question.field.split('.').pop() ?? '')) return true
    muted.push(question.field)
    return false
  })

  return {
    questions: [...questions.filter((q) => q.blocking), ...questions.filter((q) => !q.blocking)],
    muted
  }
}

export interface ClarifyAnswerValue {
  /** 折算出的克数（可换算时才有） */
  grams?: number
  /** 任意数值（组数 / 次数 / 分钟 / RPE） */
  number?: number
  /** 有氧时长的分钟数 */
  minutes?: number
  cookedState?: CookedState
}

export type ClarifyAnswer =
  | ({ kind: 'value' } & ClarifyAnswerValue)
  | { kind: 'skip' }
  | { kind: 'unknown' }

const SKIP_RE = /不记|记不清|不记得|不知道|没量|忘了|跳过|不清楚/
const MASS_UNITS = new Set(['g', 'gram', 'grams', '克', 'ml', '毫升', 'cc'])

function toHalfWidth(text: string): string {
  return text
    .replace(/[\uff10-\uff19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\uff0e/g, '.')
}

function cookedStateOf(text: string): CookedState | undefined {
  if (/熟重|煮熟|熟的|熟面|熟饭/.test(text)) return '熟'
  if (/干重|生重|生的|干的|干面/.test(text)) return '生'
  return undefined
}

function measure(qty: number, unit: string): ClarifyAnswerValue {
  const normalised = unit.toLowerCase()
  if (MASS_UNITS.has(normalised)) return { grams: qty, number: qty }
  if (unit === '小时' || normalised === 'h') return { minutes: qty * 60, number: qty }
  if (unit === '分钟' || unit === '分' || normalised === 'min') return { minutes: qty, number: qty }
  const perUnit = DEFAULT_PORTION_GRAMS[unit]
  if (perUnit) return { grams: qty * perUnit, number: qty }
  return { number: qty }
}

/**
 * 解析用户对澄清问题的回答。
 * 先找数字（阿拉伯或中文数字 + 计量词），找不到再看是不是明确的「不记 / 记不清」。
 */
export function parseClarifyAnswer(raw: string): ClarifyAnswer {
  const text = toHalfWidth((raw ?? '').trim())
  if (!text) return { kind: 'unknown' }
  const cookedState = cookedStateOf(text)

  const arabic = /(\d+(?:\.\d+)?)\s*([a-zA-Z\u4e00-\u9fa5]{0,3})/.exec(text)
  if (arabic) {
    const value = measure(Number(arabic[1]), arabic[2] ?? '')
    return { kind: 'value', ...value, ...(cookedState ? { cookedState } : {}) }
  }

  const chinese = /([零一二两三四五六七八九十半]+)\s*(克|毫升|个|只|片|碗|勺|块|根|条|把|份|盒|杯|小时|分钟|组|次)/.exec(text)
  if (chinese) {
    const qty = parseQuantity(chinese[1])
    if (qty !== undefined) {
      const value = measure(qty, chinese[2])
      return { kind: 'value', ...value, ...(cookedState ? { cookedState } : {}) }
    }
  }

  if (SKIP_RE.test(text)) return { kind: 'skip' }
  return { kind: 'unknown' }
}

/** 条目是否可以落库：有克重，或者用户明确说了不记 / 记不清（留空且不阻塞）。 */
export function isResolved(grams: number | undefined, pending: boolean, answer?: string): boolean {
  if (grams !== undefined && !pending) return true
  if (answer === undefined || answer.trim() === '') return false
  const parsed = parseClarifyAnswer(answer)
  return parsed.kind === 'value' ? parsed.grams !== undefined : parsed.kind === 'skip'
}

/** 把回答折算成最终克重：值优先，其次沿用模型/本地的估算，最后留空。 */
export function resolveGrams(item: { grams?: number; answer?: string }): number | undefined {
  if (!item.answer) return item.grams
  const parsed = parseClarifyAnswer(item.answer)
  if (parsed.kind === 'value' && parsed.grams !== undefined) return parsed.grams
  if (parsed.kind === 'skip') return undefined
  return item.grams
}
