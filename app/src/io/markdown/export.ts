/**
 * 工作区文本导出：记录 / 食物库 / 档案 / 目标 → Markdown 与 CSV
 * （T4.2 / docs/pwa-design.md §7.2，FR-1204 / FR-1206）。
 *
 * 与 `io/markdown/record.ts` 是同一份契约的两侧：那边读、这边写。验收方式就是
 * 「导出的文本原样喂回 `scripts/nutrition.py check --all` 不报错」，所以任何格式改动
 * 都必须同时照顾脚本的 `load_day` / `check` 与 `record.ts` 的解析口径。
 *
 * 三处刻意的取舍：
 * 1. **数值写「最多 3 位小数」**，不学工作区文件的 1 位小数显示 —— 导出是把数据搬出去，
 *    不该顺手砍精度；脚本与解析器都只取单元格里的第一个数字，多几位照样读得回来。
 * 2. **AUTO:SUMMARY 区块由本地 `domain/` 计算**（DR-45），渲染规则逐字对齐脚本的
 *    `summary_lines`；用户跑 `totals --write` 时会覆盖成同样的一段文字。
 * 3. 本模块只做「领域对象 → 文本」，不碰 Dexie —— 读库在 `io/workspaceExport.ts`。
 */

import { weekdayCn } from '@/app/date'
import { fmtNumber, fmtSigned } from '@/domain/format'
import { sumFacts } from '@/domain/nutrition'
import { buildHints, buildSummaryRows, type TargetValues } from '@/domain/targets'
import { aggregateWorkouts, parseSetVolume, type TrainingAggregate } from '@/domain/training'
import type {
  Confidence,
  Food,
  IntakeEntry,
  NutritionFacts,
  ProfileRecord,
  TargetsRecord,
  TodoItem,
  WorkoutEntry
} from '@/domain/types'

export const INTAKE_HEADERS = [
  '餐次',
  '菜品/做法',
  '食材',
  '份量',
  '热量(kcal)',
  '蛋白(g)',
  '脂肪(g)',
  '碳水(g)',
  '纤维(g)',
  '钠(mg)'
]
const INTAKE_ALIGN = ['---', '---', '---', '---', '---:', '---:', '---:', '---:', '---:', '---:']

export const TRAINING_HEADERS = [
  '时间',
  '类型',
  '时长(min)',
  'RPE',
  '目标肌群',
  '动作',
  '组x次x重量',
  '估算消耗(kcal)'
]
const TRAINING_ALIGN = ['---', '---', '---:', '---:', '---', '---', '---', '---:']

/** 与 `data/foods.csv` 的列序一致（`scripts/gen-seed.mjs` 读的就是这套列名）。 */
export const FOOD_CSV_HEADERS = [
  'name',
  'category',
  'unit',
  'kcal',
  'protein_g',
  'fat_g',
  'carb_g',
  'fiber_g',
  'sodium_mg',
  'note'
]

const CONFIDENCE_CN: Record<Confidence, string> = { high: '高', medium: '中', low: '低' }

/** 单元格里的数值：最多 3 位小数、去掉末尾 0，整数不带小数点；缺值写空。 */
function fmtCell(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  return String(Number(value.toFixed(3)))
}

function frontLine(key: string, value: string): string {
  return value ? `${key}: ${value}` : `${key}:`
}

function table(headers: string[], align: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${align.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ]
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * 份量文本。记录里存的是「数量 + 单位 + 折算克数」，工作区格式里是人写的自由文本
 * （`60g`、`3个(150g)`、`10g(估)`），所以这里只还原到能重新折算的最小信息 ——
 * 「(估)」这类标记本来就只存在于备注里，不在这里编造。
 */
function portionText(entry: IntakeEntry): string {
  const amount = entry.amount
  const grams = amount?.grams
  if (grams !== undefined && Number.isFinite(grams)) {
    return `${fmtCell(grams)}${entry.foodSnapshot.unit.includes('ml') ? 'ml' : 'g'}`
  }
  const qty = amount?.qty
  if (qty !== undefined && Number.isFinite(qty)) return `${fmtCell(qty)}${amount?.unit ?? ''}`
  return amount?.unit ?? ''
}

/**
 * 「组x次x重量」。优先原样回写用户输入（`volumeRaw`）—— 它本来就是从这句话解析出来的，
 * 回写不会掉精度；没有原始文本时才按 `sets` 还原（组内次数/重量不一致时只能记第一组，
 * 这种情况工作区格式本身也表达不了）。
 */
function volumeText(entry: WorkoutEntry): string {
  if (entry.volumeRaw && parseSetVolume(entry.volumeRaw)) return entry.volumeRaw.trim()
  const sets = entry.sets ?? []
  if (!sets.length) return ''
  const [first] = sets
  const uniformWeight = sets.every((set) => set.weightKg === first.weightKg)
  const weightMark = uniformWeight && first.weightKg !== undefined ? fmtCell(first.weightKg) : '自重'
  return `${sets.length}x${first.reps}x${weightMark}`
}

function intakeRow(entry: IntakeEntry): string[] {
  const facts = entry.computed
  return [
    entry.meal,
    entry.dish ?? '',
    entry.foodSnapshot.name || entry.foodId,
    portionText(entry),
    fmtCell(facts.kcal),
    fmtCell(facts.proteinG),
    fmtCell(facts.fatG),
    fmtCell(facts.carbG),
    fmtCell(facts.fiberG),
    fmtCell(facts.sodiumMg)
  ]
}

function trainingRow(entry: WorkoutEntry): string[] {
  return [
    entry.time ?? '',
    entry.type,
    fmtCell(entry.minutes),
    fmtCell(entry.rpe),
    (entry.muscles ?? []).join('、'),
    entry.exercise ?? '',
    volumeText(entry),
    fmtCell(entry.estimatedKcal)
  ]
}

export interface SummaryBlockInput {
  intake: NutritionFacts
  targets: TargetValues
  weightAmKg?: number
  weightPmKg?: number
  training: TrainingAggregate
}

/**
 * AUTO:SUMMARY 的正文行。渲染规则逐字对齐 `scripts/nutrition.py` 的 `summary_lines`：
 * 目标缺失（未校准）时那一行只写「摄入」，钠那一行前缀 `≤`，训练行按
 * `动作数 · 分钟 · 合计组数 · 容量负荷 · 自重组数 · 估算消耗 · RPE` 组装。
 */
export function summaryBlockLines(input: SummaryBlockInput): string[] {
  const lines = ['| 项目 | 摄入 | 目标 | 差额 | 占比 |', '| --- | ---: | ---: | ---: | ---: |']
  for (const row of buildSummaryRows(input.intake, input.targets)) {
    if (!row.target) {
      lines.push(`| ${row.label} | ${fmtNumber(row.intake)} | - | - | - |`)
      continue
    }
    const prefix = row.key === 'sodiumMg' ? '≤' : ''
    const share = `${Math.round(row.ratio * 100)}%`
    lines.push(
      `| ${row.label} | ${fmtNumber(row.intake)} | ${prefix}${fmtNumber(row.target)} | ${fmtSigned(row.diff)} | ${share} |`
    )
  }

  const weightParts: string[] = []
  const am = input.weightAmKg
  const pm = input.weightPmKg
  if (am !== undefined) weightParts.push(`晨重 ${fmtNumber(am)} kg`)
  if (pm !== undefined) weightParts.push(`睡前 ${fmtNumber(pm)} kg`)
  if (am !== undefined && pm !== undefined) weightParts.push(`当日净增 ${fmtSigned(pm - am)} kg`)
  lines.push('')
  if (weightParts.length) {
    lines.push(`**体重**：${weightParts.join(' · ')}`)
    lines.push('')
  }

  const training = input.training
  if (training.rows) {
    const pieces = [`${training.rows} 个动作`]
    if (training.minutes) pieces.push(`${fmtNumber(training.minutes)} 分钟`)
    pieces.push(`合计 ${training.sets} 组`)
    if (training.load) pieces.push(`容量负荷 ${fmtNumber(training.load)} kg`)
    if (training.bodyweightSets) pieces.push(`自重 ${training.bodyweightSets} 组`)
    pieces.push(`估算消耗 ${fmtNumber(training.burn)} kcal`)
    const rpe = training.rpe.length
      ? fmtNumber(training.rpe.reduce((sum, value) => sum + value, 0) / training.rpe.length)
      : '-'
    pieces.push(`RPE ${rpe}`)
    lines.push(`**训练**：${pieces.join(' · ')}`)
    const muscles = Object.entries(training.muscles)
      .map(([name, sets]) => `${name} ${sets}组`)
      .join('、')
    if (muscles) lines.push(`**涉及肌群**：${muscles}`)
  } else {
    lines.push('**训练**：无记录（休息日）')
  }

  const hints = buildHints(input.intake, input.targets)
  if (hints.length) {
    lines.push('')
    for (const hint of hints) lines.push(`- ${hint}`)
  }
  return lines
}

/** AUTO:SUMMARY 区块（含围栏注释），位置固定在记录文件末尾。 */
export function autoSummaryBlock(input: SummaryBlockInput): string {
  return [
    '<!-- AUTO:SUMMARY:BEGIN -->',
    ...summaryBlockLines(input),
    '<!-- AUTO:SUMMARY:END -->'
  ].join('\n')
}

export interface RecordExportInput {
  date: string
  /** 缺省按日期推算，与 `data/repositories/days.ts` 同一张表 */
  weekday?: string
  weightAmKg?: number
  weightPmKg?: number
  sleepHours?: number
  energy?: number
  soreness?: number
  note?: string
  todos?: readonly TodoItem[]
  intake: readonly IntakeEntry[]
  workout: readonly WorkoutEntry[]
  targets: TargetValues
}

/**
 * 当日记录 → `records/YYYY-MM-DD.md` 全文（front-matter + 四段正文 + AUTO 区块）。
 *
 * `## 待办` 永远排在「状态与备注」之后、AUTO 区块之前：正文按 `##` 切段，AUTO 区块因此
 * 落在「待办」段里，而 `parseTodos` 只认 `- [ ]` / `- [x]` 行，不会被区块里的表格污染；
 * 反过来如果让区块跟着备注段，那整段（含区块）会被当备注读回来。
 */
export function renderRecordFile(input: RecordExportInput): string {
  const weekday = input.weekday || weekdayCn(input.date)
  const note = input.note?.trim()
  const todos = input.todos ?? []
  const lines = [
    '---',
    `date: ${input.date}`,
    `weekday: ${weekday}`,
    frontLine('weight_am_kg', fmtCell(input.weightAmKg)),
    frontLine('weight_pm_kg', fmtCell(input.weightPmKg)),
    frontLine('sleep_hours', fmtCell(input.sleepHours)),
    frontLine('energy', fmtCell(input.energy)),
    frontLine('soreness', fmtCell(input.soreness)),
    '---',
    '',
    `# ${input.date} ${weekday} 每日记录`,
    '',
    '## 摄入',
    '',
    ...table(INTAKE_HEADERS, INTAKE_ALIGN, input.intake.map(intakeRow)),
    '',
    '## 训练',
    '',
    ...table(TRAINING_HEADERS, TRAINING_ALIGN, input.workout.map(trainingRow)),
    '',
    '## 状态与备注'
  ]
  if (note) lines.push('', ...note.split('\n'))
  lines.push('', '## 待办')
  if (todos.length) lines.push('', ...todos.map((todo) => `- [${todo.done ? 'x' : ' '}] ${todo.text}`))
  const summary = autoSummaryBlock({
    intake: sumFacts(input.intake.map((entry) => entry.computed)),
    targets: input.targets,
    weightAmKg: input.weightAmKg,
    weightPmKg: input.weightPmKg,
    training: aggregateWorkouts(input.workout)
  })
  return `${lines.join('\n')}\n\n${summary}\n`
}

/** `source=llm` 的条目在这里注明来源与置信度（FR-405 的留痕要求，导出后也不能丢）。 */
function foodNote(food: Food): string {
  const parts: string[] = []
  if (food.edibleNote) parts.push(food.edibleNote)
  if (food.sourceNote && !food.edibleNote) parts.push(food.sourceNote)
  if (food.source === 'llm') {
    parts.push(`来源：模型${food.confidence ? `（置信度 ${CONFIDENCE_CN[food.confidence]}）` : ''}`)
  } else if (food.source === 'manual') {
    parts.push('来源：手工录入')
  }
  const perHundred = food.unit.startsWith('100')
  if (!perHundred && food.basisGrams) parts.push(`1${food.unit}=${fmtCell(food.basisGrams)}g`)
  // 非 100g/100ml 的基准必须在 note 里写清依据，否则 `gen-seed.mjs` 会拒绝这一行
  if (!parts.length && !perHundred) parts.push(`基准单位 ${food.unit}`)
  return parts.join('；')
}

/** 食物库 → `data/foods.csv`（列序与种子文件一致，按名称排序保证导出可复现）。 */
export function renderFoodsCsv(foods: readonly Food[]): string {
  const sorted = [...foods].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const rows = sorted.map((food) =>
    [
      food.name,
      food.category,
      food.unit,
      fmtCell(food.kcal),
      fmtCell(food.proteinG),
      fmtCell(food.fatG),
      fmtCell(food.carbG),
      fmtCell(food.fiberG),
      fmtCell(food.sodiumMg),
      foodNote(food)
    ]
      .map(csvField)
      .join(',')
  )
  return `${[FOOD_CSV_HEADERS.join(','), ...rows].join('\n')}\n`
}

/** 追加一段 `## 标题` + 空行 + 项目符号（列表为空时整段省略）。 */
function pushSection(lines: string[], title: string, items: string[]): void {
  if (!items.length) return
  lines.push('', `## ${title}`, '', ...items)
}

/** 档案 → `profile.md`。front-matter 的键名是脚本读的（`cmd_init`），不能改名。 */
export function renderProfileFile(profile: ProfileRecord): string {
  const lines = [
    '---',
    '# 机器可读字段：脚本与对拍测试读取这些键名，请勿改名。未知值留空。',
    frontLine('name', profile.name?.trim() ?? ''),
    frontLine('sex', profile.sex),
    frontLine('age', fmtCell(profile.age)),
    frontLine('height_cm', fmtCell(profile.heightCm)),
    frontLine('weight_kg', fmtCell(profile.weightKg)),
    frontLine('body_fat_pct', fmtCell(profile.bodyFatPct)),
    frontLine('goal', profile.goal),
    frontLine('training_level', profile.trainingLevel),
    frontLine('training_years', fmtCell(profile.trainingYears)),
    frontLine('wake_time', profile.wakeTime ?? ''),
    frontLine('sleep_time', profile.sleepTime ?? ''),
    '---',
    '',
    '# 基础档案',
    '',
    '长期稳定的事实，只在真正变化时修改。目标、热量与训练策略写在 `targets.md`。'
  ]
  const body: string[] = [`- 起始体重：${fmtCell(profile.weightKg)} kg`, `- 目标：${profile.goal}`]
  if (profile.bodyFatPct !== undefined) body.push(`- 体脂率：${fmtCell(profile.bodyFatPct)}%`)
  pushSection(lines, '身体与目标背景', body)

  const training = [`- 训练水平：${profile.trainingLevel}`]
  if (profile.trainingYears !== undefined) training.push(`- 训练年限：${fmtCell(profile.trainingYears)} 年`)
  pushSection(lines, '训练背景', training)

  // 四项安全边界（T3.8 / FR-1003）：写在正文里给人和脚本看；机器读的那份在导出包里。
  // 没填就不写这一节，免得导出文件里出现一堆空行。
  const constraints: string[] = []
  if (profile.avoidFoods?.length) constraints.push(`- 忌口：${profile.avoidFoods.join('、')}`)
  if (profile.allergies?.length) constraints.push(`- 过敏：${profile.allergies.join('、')}`)
  if (profile.equipment?.length) constraints.push(`- 可用器材：${profile.equipment.join('、')}`)
  if (profile.mealMinutes) constraints.push(`- 每餐可投入时间：${fmtCell(profile.mealMinutes)} 分钟`)
  pushSection(lines, '饮食与训练约束', constraints)

  pushSection(lines, '作息', [`- 起床 / 入睡时间：${profile.wakeTime || '-'} / ${profile.sleepTime || '-'}`])
  pushSection(lines, '记录口径约定', (profile.conventions ?? []).map((line) => `- ${line}`))
  return `${lines.join('\n')}\n`
}

/** 目标 → `targets.md`。front-matter 的键名是脚本读的（`summary_lines` / `tdee`）。 */
export function renderTargetsFile(targets: TargetsRecord): string {
  const lines = [
    '---',
    '# 机器可读字段：脚本读取这些目标值做达标对比。',
    frontLine('tdee_kcal', fmtCell(targets.tdeeKcal)),
    frontLine('kcal_target', fmtCell(targets.kcalTarget)),
    frontLine('protein_target_g', fmtCell(targets.proteinTargetG)),
    frontLine('fat_target_g', fmtCell(targets.fatTargetG)),
    frontLine('carb_target_g', fmtCell(targets.carbTargetG)),
    frontLine('fiber_target_g', fmtCell(targets.fiberTargetG)),
    frontLine('sodium_max_mg', fmtCell(targets.sodiumMaxMg)),
    frontLine('weekly_training_days', fmtCell(targets.weeklyTrainingDays)),
    frontLine('weekly_sets_per_muscle', fmtCell(targets.weeklySetsPerMuscle)),
    frontLine('target_weight_kg', fmtCell(targets.targetWeightKg)),
    frontLine('target_rate_kg_per_week', fmtCell(targets.targetRateKgPerWeek)),
    frontLine('review_cadence', targets.reviewCadence),
    frontLine('last_calibrated', targets.lastCalibrated ?? ''),
    '---',
    '',
    '# 目标与策略',
    '',
    '短期可变的决策变量，由复盘流程校准后回写。'
  ]
  const bullets = [
    `- 热量目标：${fmtCell(targets.kcalTarget)} kcal（TDEE ${fmtCell(targets.tdeeKcal)} kcal）`,
    `- 每周训练下限：${fmtCell(targets.weeklyTrainingDays)} 天；每肌群每周有效组数下限：${fmtCell(targets.weeklySetsPerMuscle)} 组`,
    `- 目标体重：${fmtCell(targets.targetWeightKg)} kg；目标速率：${fmtCell(targets.targetRateKgPerWeek)} kg/周`
  ]
  if (targets.lastCalibrated) bullets.push(`- 上次校准：${targets.lastCalibrated}`)
  pushSection(lines, '要点', bullets)
  return `${lines.join('\n')}\n`
}
