/**
 * 领域对象契约。字段口径对应 docs/pwa-design.md §4.2 与 README.md 的格式契约。
 *
 * 注意：IndexedDB 的索引键只支持 string / number / Date / ArrayBuffer / Array，
 * 布尔值不能作为索引键。因此所有需要建索引的布尔语义字段统一用 0/1 表示。
 */

export type Meal = '早餐' | '午餐' | '晚餐' | '加餐'
export type FoodSource = 'seed' | 'llm' | 'manual'
export type Confidence = 'high' | 'medium' | 'low'
/**
 * 计量基准：营养数值一律表示「每个基准单位」的数值。
 * 常见取值：'100g'、'100ml'、'个'（按件，单件克重未知时只能按件计）。
 */
export type FoodUnit = string
export type WorkoutType = '力量' | '有氧' | '球类' | '拉伸' | '其他'
export type ReportType = 'weekly' | 'monthly'
export type Flag = 0 | 1

export interface PortionBasis {
  /** 如「1个」「1碗」 */
  label: string
  /** 折算克数 */
  grams: number
}

export interface NutritionFacts {
  kcal: number
  proteinG: number
  fatG: number
  carbG: number
  fiberG: number
  sodiumMg: number
}

export interface Food extends NutritionFacts {
  /** 主键：食物名称（去重后唯一） */
  id: string
  name: string
  /** 归一化名称，用于去重与检索 */
  nameNorm: string
  category: string
  unit: FoodUnit
  /** 当基准不是 100g/100ml 时，单基准单位对应的克数；未知则留空 */
  basisGrams?: number
  /** 生熟 / 可食部说明 */
  edibleNote?: string
  cookedState?: '生' | '熟' | '市售'
  portions?: PortionBasis[]
  source: FoodSource
  /** 数值来源说明（FR-405 / DR-05） */
  sourceNote?: string
  confidence?: Confidence
  /** 0/1 代替布尔值，便于建索引 */
  disabledFlag?: Flag
  createdAt: number
  updatedAt: number
}

export interface FoodSnapshot extends NutritionFacts {
  name: string
  unit: FoodUnit
  basisGrams?: number
}

export interface Amount {
  qty: number
  unit: string
  /** 折算后的克数 / 毫升数；按件且克重未知时为 undefined */
  grams?: number
}

export interface IntakeEntry {
  id: string
  date: string
  meal: Meal
  /** 菜品/做法，同一道菜的多个食材共用 */
  dish: string
  foodId: string
  /** 冗余快照，保证历史记录不随食物库修改而变形 */
  foodSnapshot: FoodSnapshot
  amount: Amount
  computed: NutritionFacts
  /** 营养待补全 */
  pendingFlag?: Flag
  note?: string
}

export interface WorkoutSet {
  reps: number
  weightKg?: number
  bodyweight: boolean
}

export interface WorkoutEntry {
  id: string
  date: string
  time?: string
  type: WorkoutType
  minutes?: number
  rpe?: number
  muscles: string[]
  exercise: string
  sets?: WorkoutSet[]
  /** 用户输入的原始「组x次x重量」写法，导出时原样回写，避免精度丢失 */
  volumeRaw?: string
  /** 容量负荷 = 组 × 次 × 重量，自重不计 */
  volumeLoad?: number
  /** 有氧消耗：MET × 3.5 × 体重 / 200 × 时长 */
  estimatedKcal?: number
  note?: string
}

export interface DaySummaryRow {
  key: 'kcal' | 'proteinG' | 'fatG' | 'carbG' | 'fiberG' | 'sodiumMg'
  label: string
  intake: number
  target: number
  diff: number
  /** 0-1 之间的比例；钠为 摄入 / 上限 */
  ratio: number
}

export interface DaySummary {
  date: string
  rows: DaySummaryRow[]
  weightAmKg?: number
  weightPmKg?: number
  training: { minutes: number; sets: number; volumeLoadKg: number; isRestDay: boolean }
  /** 存在待补全条目时为 true，汇总需标注不完整 */
  incomplete: boolean
  pendingCount: number
  hints: string[]
  computedAt: number
}

export interface TodoItem {
  text: string
  done: boolean
}

export interface DayRecord {
  date: string
  weekday: string
  weightAmKg?: number
  weightPmKg?: number
  sleepHours?: number
  energy?: number
  soreness?: number
  note?: string
  todos?: TodoItem[]
  summarySnapshot?: DaySummary
  pendingCount: number
  createdAt: number
  updatedAt: number
}

export interface ReportDigest {
  period: { type: ReportType; label: string; start: string; end: string; days: number }
  coverage: { daysWithIntake: number; daysWithWeight: number; ratio: number }
  intake: {
    avgKcal: number
    target: number
    avgProteinG: number
    proteinTargetG: number
    kcalHitDays: number
    proteinHitDays: number
    recordedDays: number
  }
  weight: {
    amSeries: { date: string; kg: number }[]
    ma7?: number
    changeKg?: number
    changePctPerWeek?: number
  }
  training: {
    days: number
    minutes: number
    sets: number
    volumeLoadKg: number
    byMuscle: { muscle: string; sets: number }[]
    targetDays: number
    targetSetsPerMuscle: number
  }
  currentTargets: { kcalTarget: number; proteinTargetG: number; lastCalibrated?: string }
  tdee?: { value: number; sampleDays: number; confidence: '初步估算' | '可用' }
  previousDigest?: { period: string; conclusion: string }
}

export interface ReportContent {
  summary: string
  training: { assessment: string; notes: string[] }
  diet: { assessment: string; notes: string[] }
  recovery: { notes: string[] }
  findings: { kind: 'fact' | 'inference'; text: string }[]
  issues: string[]
  actions: string[]
  calibration: { recommended: boolean; deltaKcal: number; rationale: string }
  disclaimer: string
}

export interface ReportRecord {
  id: string
  type: ReportType
  label: string
  periodStart: string
  periodEnd: string
  /** 本地聚合数值，永远来自 domain 计算 */
  digest: ReportDigest
  /** 模型输出的结论部分；未生成为 null */
  content: ReportContent | null
  status: 'draft' | 'pending' | 'ready'
  model?: string
  taskVersion?: number
  /** 模型文本中被守卫标记为待核对的数字 */
  flaggedNumbers?: string[]
  editedByUser: boolean
  createdAt: number
  updatedAt: number
}

export interface CalibrationRecord {
  id: string
  date: string
  measuredTdee: number
  kcalBefore: number
  kcalAfter: number
  basis: string
  createdAt: number
}

export interface TargetsRecord {
  id: 'current'
  tdeeKcal: number
  kcalTarget: number
  proteinTargetG: number
  fatTargetG: number
  carbTargetG: number
  fiberTargetG: number
  sodiumMaxMg: number
  weeklyTrainingDays: number
  weeklySetsPerMuscle: number
  targetWeightKg: number
  targetRateKgPerWeek: number
  reviewCadence: 'weekly' | 'monthly'
  lastCalibrated?: string
  updatedAt: number
}

export interface ProfileRecord {
  id: 'current'
  name?: string
  sex: 'male' | 'female'
  age: number
  heightCm: number
  weightKg: number
  bodyFatPct?: number
  goal: '减脂' | '增肌' | '重组'
  trainingLevel: '新手' | '中级' | '高级'
  trainingYears?: number
  injuries?: string
  allergies?: string
  dietType?: string
  dailyCookMinutes: number
  budgetPerDayCny?: number
  wakeTime?: string
  sleepTime?: string
  /** 调味料有无：{ 盐: true, 蚝油: false } */
  seasonings: Record<string, boolean>
  /** 可用器材 */
  equipment: string[]
  /** 记录口径约定（长期），如「不记饮水」 */
  conventions: string[]
  /** 不再追问的字段（M11 / FR-1103） */
  mutedFields: string[]
  updatedAt: number
}

export interface ReminderSetting {
  id: string
  label: string
  time: string
  enabled: boolean
}

export interface SettingsRecord {
  id: 'current'
  units: { weight: 'kg'; energy: 'kcal' }
  weekStart: 1 | 7
  theme: 'light' | 'dark' | 'auto'
  reminders: ReminderSetting[]
  mutedFields: string[]
  lastBackupAt?: number
  updatedAt: number
}

export interface ModelConfigRecord {
  id: 'current'
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  /** 探测结果：接口是否支持 response_format=json_object */
  supportsJsonResponse?: boolean
  enabled: boolean
  lastTestAt?: number
  lastTestOk?: boolean
  lastTestMessage?: string
  updatedAt: number
}

export interface LlmLog {
  id: string
  taskId: string
  taskVersion: number
  model: string
  durationMs: number
  promptTokensEst: number
  completionTokensEst: number
  status: 'ok' | 'error'
  errorKind?: string
  createdAt: number
}

/**
 * 自由文本 / 图片解析出的草稿（§6.11）。
 *
 * 草稿不是数据：不参与当日汇总（DR-48），澄清答完并由用户确认后才落成
 * `IntakeEntry` / `WorkoutEntry`。
 */
export type DraftKind = 'intake' | 'workout'
export type DraftStatus = 'collecting' | 'ready' | 'committed' | 'discarded'

export interface DraftQuestion {
  /** 字段 id，形如 `面条(干).grams`；用于去重与回填 */
  field: string
  question: string
  options: string[]
  /** true = 无值即无法计算，会阻塞该条目落库 */
  blocking: boolean
  source: 'model' | 'local'
}

export interface DraftIntakeItem {
  key: string
  dish: string
  food: string
  amountText: string
  grams?: number
  cookedState?: '生' | '熟' | '市售'
  /** 模型自己也没把握，或克重缺失 */
  pending: boolean
  confidence: Confidence
  /** 用户对澄清问题的回答原文；留空表示还没答 */
  answer?: string
}

export interface DraftWorkoutItem {
  key: string
  exercise: string
  sets?: number
  reps?: number
  weightKg?: number
  bodyweight: boolean
}

export interface DraftRecord {
  id: string
  date: string
  kind: DraftKind
  status: DraftStatus
  /** 用户输入的原文，落库时写进记录备注（FR-114） */
  rawText: string
  /** 图片只统计张数，内容不落库（FR-1417） */
  imageCount: number
  meal: Meal
  dish: string
  intake: DraftIntakeItem[]
  workout: { type: WorkoutType; minutes?: number; rpe?: number; exercises: DraftWorkoutItem[] }
  questions: DraftQuestion[]
  assumptions: string[]
  uncertain: string[]
  model?: string
  taskVersion?: number
  createdAt: number
  updatedAt: number
}

export interface PendingOp {
  id: string
  kind: 'food.resolve' | 'report.generate' | 'log.parse'
  /** 关联对象 id（如日期、报告 id、草稿 id） */
  ref: string
  status: 'queued' | 'waiting' | 'needs-attention' | 'done'
  attempts: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface SnapshotRecord {
  id: string
  date: string
  reason: string
  payload: string
  createdAt: number
}

export interface MetaRecord {
  key: string
  value: unknown
  updatedAt: number
}
