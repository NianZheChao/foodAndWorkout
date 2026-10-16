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
    /** 钠与纤维：与 `domain/targets.ts` 的缺口提示同口径（钠超上限的天数、纤维达标的天数） */
    avgSodiumMg: number
    sodiumMaxMg: number
    sodiumOverDays: number
    avgFiberG: number
    fiberTargetG: number
    fiberHitDays: number
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
    /** 主观强度：条目数加权（一场训练一行），高 RPE 用 ≥8 计 */
    rpeAvg?: number
    highRpeEntries?: number
    /** 有氧 / 球类的估算消耗合计（kcal） */
    burnKcal: number
  }
  /**
   * 恢复（2026-10-16 新增，§6.4.1）。
   *
   * 输出契约里本来就有 `recovery.notes`，但此前摘要**没有任何恢复类输入** —— 模型只能写空话。
   * 自报数据稀疏，所以每个指标都带"有几天记录"，让模型知道样本量（NFR-14：只给能支撑建议的字段）。
   */
  recovery: {
    /** 有睡眠记录的天数 */
    sleepDays: number
    avgSleepHours?: number
    /** 睡眠不足 6 小时的天数（唯一真正可行动的那一档） */
    shortSleepDays?: number
    /** 有精力 / 酸痛自评的天数（两者同页填写） */
    ratedDays: number
    /** 精力 ≤2 的天数 */
    lowEnergyDays?: number
    /** 酸痛 ≥4 的天数 */
    highSorenessDays?: number
  }
  currentTargets: { kcalTarget: number; proteinTargetG: number; lastCalibrated?: string }
  tdee?: { value: number; sampleDays: number; confidence: '初步估算' | '可用' }
  previousDigest?: {
    period: string
    conclusion: string
    /** 上一期的关键数字：给了才能做真正可核对的「环比」（只给文字结论时模型只能随口说） */
    numbers?: PreviousDigestNumbers
  }
}

/** 上一期的关键数字（环比用）。刻意只留这几项：每多一项都要能说清它支撑哪条结论（NFR-14）。 */
export interface PreviousDigestNumbers {
  avgKcal: number
  recordedDays: number
  kcalHitDays: number
  proteinHitDays: number
  trainingDays: number
  volumeLoadKg: number
  weightChangeKg?: number
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

/** 每日指导（T3.7 / §6.4.2）。`kind` 与报告一致：事实 / 推断必须由模型自己标出来。 */
export type AdviceKind = 'fact' | 'inference'

/**
 * 一条指导建议。
 *
 * `basis` 是它与本地数字的挂钩（NFR-13）：必须命中摘要 / 当日缺口里**真实存在**的字段路径，
 * 命中不了的整条不展示 —— 依据是这套东西的底线，不是装饰。
 */
export interface CoachAdviceItem {
  kind: AdviceKind
  text: string
  /** 字段路径：`today.` 开头相对当日缺口，其余相对摘要（如 `intake.avgProteinG`） */
  basis: string[]
  /** 用户表态：true 采纳 / false 不采纳 / undefined 还没说 —— 下一轮 `history.advice` 只带表过态的 */
  adopted?: boolean
}

export interface CoachContent {
  headline: string
  advice: CoachAdviceItem[]
  focus: string[]
  ask: string[]
  disclaimer: string
}

/**
 * 当日缺口（`coach.daily` 输入的 today 块）。
 *
 * `remainingKcal` / `remainingProteinG` 在**没有目标**时留空：没目标就没有「还差多少」，
 * 补 0 等于给模型一个可以引用的事实（和摘要里空值一律留空同一条纪律）。
 */
export interface CoachTodayGap {
  kcalSoFar: number
  proteinSoFarG: number
  remainingKcal?: number
  remainingProteinG?: number
  pendingItems: number
  trainedToday: boolean
  weightAmKg?: number
}

/**
 * 一天的指导（`adviceLog`，§6.4.2）。
 *
 * 同日默认只生成一次：`fingerprint` 是「摘要 + 当日缺口」的指纹，数据变了（或用户手动刷新）
 * 才重新调用模型 —— 指导是高频调用，不能每次打开页面都花钱（FR-1409 / §6.9 结果缓存）。
 */
export interface AdviceRecord {
  id: string
  date: string
  content: CoachContent
  fingerprint: string
  model?: string
  taskVersion?: number
  /** 模型文本里被数字守卫标为「待核对」的数字（与报告同一套规则） */
  flaggedNumbers?: string[]
  /** 被依据校验丢掉、没有展示的建议条数：丢了内容要能说明，不能静默 */
  droppedAdvice?: number
  /** 本地闸门给出的提示（样本不足、被去掉的调整目标类建议等） */
  notices?: string[]
  createdAt: number
  updatedAt: number
}

/**
 * 生成式推荐（B 级，T3.8 / §6.5 / §6.6）。
 *
 * 与 A 级指导的分工是**很清楚**的：指导只说「往哪使劲」，推荐给的是**具体清单**
 * （练哪几个动作、吃哪几样、各多少克）。清单里带数字，所以数值一律本地复算（FR-806），
 * 模型自报的合计只用来比对，不展示。
 *
 * 两种计划共用一张表（`plans`），靠 `kind` 区分：
 * `training` = 今天练什么（FR-801），`meal` = 今天还能吃什么（FR-802）。
 */
/**
 * 生成式推荐（B 级，T3.8 / §6.5 / §6.6）。
 *
 * 与 A 级指导的分工很清楚：指导只说「往哪使劲」，推荐给的是**具体清单**
 * （练哪几个动作、吃哪几样、各多少克）。清单里带数字，所以数值一律本地复算（FR-806），
 * 模型自报的合计只用来比对，不展示。
 *
 * 两种计划共用一张表（`plans`），靠 `kind` 区分：
 * `training` = 今天练什么（FR-801），`meal` = 今天还能吃什么（FR-802）。
 */
export type PlanKind = 'training' | 'meal'

/**
 * 一条推荐食材（**本地复算之后**的形态，落库与展示都用这一份）。
 *
 * `facts` / `foodId` / `matchedName` 由本地按食物库补上：命中库里的条目才有，
 * 命中不了（`facts` 为空）的行**不进合计**，只标出来让用户自己去食物库补（FR-806）。
 */
export interface PlanMealLine {
  food: string
  grams: number
  dish?: string
  /** 调味料行在界面上与主料分开列 */
  seasoning?: boolean
  /** 命中的食物库条目 */
  foodId?: string
  matchedName?: string
  /** 本地按食物库算出的这一行的营养 */
  facts?: NutritionFacts
}

export interface ShoppingItem {
  item: string
  amount: string
  /** 不买也能做的替代（FR-804） */
  substitute?: string
}

/**
 * 「今天吃什么」的落库内容：食材行、本地的四项合计、采购清单。
 *
 * `totals` 是**本地按食物库算的**（FR-806），`totalsPreview` 是模型自报的那一份 —— 留着它
 * 只为对账（偏差异常时界面要说得清「模型说的是多少」），展示永远用 `totals`。
 */
export interface PlanMealContent {
  title: string
  items: PlanMealLine[]
  seasonings: PlanMealLine[]
  totals: NutritionFacts
  /** 本地库里找不到的食材名（这些行没进合计） */
  missing: string[]
  totalsPreview?: { kcal: number; proteinG: number; fatG: number; carbG: number }
  shoppingList?: ShoppingItem[]
}

/**
 * 一个推荐动作。`equipmentNote` / `weightNote` 是**本地复核**留下的提示
 * （器材核不了、加重超过 +10%），只由 `domain/plan.ts` 写。
 */
export interface PlanTrainingExercise {
  name: string
  muscles: string[]
  sets: number
  reps: number
  weightKg?: number
  rpe?: number
  /** 这个动作要用到的器材；本地拿它比对档案里的可用器材（§6.5 的本地处理） */
  equipment?: string[]
  /** 渐进说明，如「比上次 +2.5kg」 */
  progression?: string
  reason: string
  equipmentNote?: string
  weightNote?: string
}

/**
 * 「今天练什么」的落库内容。
 *
 * `estimatedMinutes` 与契约里的同名字段**不是一回事**：这里是本地按组数算出来的
 * （`domain/plan.ts` 的 `MINUTES_PER_SET`），模型写的那份只进 `notices` 做比对。
 */
export interface PlanTrainingContent {
  focus: string
  estimatedMinutes: number
  exercises: PlanTrainingExercise[]
  notes: string[]
}

export interface PlanRecordBase {
  id: string
  date: string
  /** 「输入没变就不重复花钱」的指纹（与每日指导同一套，见 `domain/fingerprint.ts`） */
  fingerprint: string
  model?: string
  taskVersion?: number
  /** 本地闸门给出的提示（剔除了哪个动作、模型估算与本地库不一致等） */
  notices?: string[]
  createdAt: number
  updatedAt: number
}

export interface TrainingPlanRecord extends PlanRecordBase {
  kind: 'training'
  content: PlanTrainingContent
}

export interface MealPlanRecord extends PlanRecordBase {
  kind: 'meal'
  content: PlanMealContent
}

export type PlanRecord = TrainingPlanRecord | MealPlanRecord

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
  /**
   * 只放**会被读**的字段：性别 / 年龄 / 身高 / 体重 / 目标 / 训练水平供首次目标估算使用
   * （`domain/calibration.ts`）。
   *
   * 2026-10-16 的档案瘦身删掉过 `injuries` / `allergies` / `dietType` / `dailyCookMinutes` /
   * `budgetPerDayCny` / `seasonings` / `equipment` / `mutedFields`（当时判断「不做推荐」）。
   * 后来 B 级生成式推荐重新立项（T3.8），按 FR-1003 恢复其中四项作为**安全边界**：
   * 忌口 / 过敏 / 可用器材 / 每餐时间，见下面四个字段。仍不恢复的是 `budgetPerDayCny`、
   * `injuries`、`dietType`、`seasonings`（推荐输入里用不到）与 `mutedFields`（与设置里那份重复，
   * 澄清引擎读的是 `SettingsRecord.mutedFields`）。
   * 老数据里残留这些键不影响读取（IndexedDB 允许多余字段）。
   */
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
  wakeTime?: string
  sleepTime?: string
  /** 记录口径约定（长期），如「不记饮水」 */
  conventions: string[]
  /**
   * 「推荐」的四项安全边界（T3.8 / FR-1003）。**四项齐了才能在设置页打开 B 级开关**
   * （门禁在 `domain/recommend.ts`）。
   *
   * 口径是「已确认」：没有忌口 / 过敏就填「无」，**不留空** —— 留空既表示不了「没有」，
   * 也看不出「还没填」，而分不清这两件事的推荐就可能把过敏源写进菜单。
   * 老档案没有这几个键，读取时按空处理（`?? []`）。
   */
  avoidFoods?: string[]
  allergies?: string[]
  equipment?: string[]
  /** 每餐能投入的分钟数；未填留空（不拿 0 顶替，DR-04） */
  mealMinutes?: number
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
  /**
   * FR-1602（2026-10-16 提升为所有调用）：指导类调用频率高，睡眠 / 精力 / 酸痛要能**单独**关掉。
   * 关掉的字段既不进摘要聚合，也不进请求体；缺省（老数据）视为全开，见 `application/coach.ts` 的读法。
   */
  shareRecovery?: { sleep: boolean; energy: boolean; soreness: boolean }
  /**
   * B 级生成式推荐的总开关（T3.8 / FR-1003）：**默认关**，而且只有档案里四项约束填齐后
   * 才能在设置页打开（门禁在 `domain/recommend.ts`）。老数据没有这个键 = 关。
   */
  recommendEnabled?: boolean
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
