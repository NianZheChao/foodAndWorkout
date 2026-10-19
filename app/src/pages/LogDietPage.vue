<script setup lang="ts">
/**
 * 记饮食面板（M1 / FR-100），由 LogHubPage 承载。路由与日期归 hub 管，这里只读 store。
 *
 * P0 只做「选食物 + 填份量」的确定性路径；
 * 自由文本与图片解析在阶段 2 接入（§6.11），到时复用同一套确认卡片。
 */

import { computed, ref, watch } from 'vue'
import { showToast } from 'vant'
import { useDayStore } from '@/store/day'
import { emptyFactsDraft, type FoodFactsDraft } from '@/domain/foodEdit'
import { hasKnownNutrition, reviewIntakeCompletion } from '@/domain/intakeCompletion'
import {
  factsForGrams,
  NUTRIENT_KEYS,
  NUTRIENT_LABELS,
  NUTRIENT_UNITS,
  type NutrientKey
} from '@/domain/nutrition'
import { parsePortionInput, resolvePortion } from '@/domain/portion'
import { searchFoods, upsertFood } from '@/data/repositories/foods'
import { fmtNumber } from '@/domain/format'
import type { Food, IntakeEntry, Meal, NutritionFacts } from '@/domain/types'

const MEALS: Meal[] = ['早餐', '午餐', '晚餐', '加餐']

const store = useDayStore()
const meal = ref<Meal>('早餐')
const query = ref('')
const results = ref<Food[]>([])
const selected = ref<Food>()
const portionText = ref('')
const dish = ref('')
const busy = ref(false)

const manualVisible = ref(false)
const manual = ref({
  name: '',
  unit: '100g',
  kcal: '',
  protein: '',
  fat: '',
  carb: '',
  fiber: '',
  sodium: ''
})

watch(
  () => query.value,
  async (value) => {
    results.value = await searchFoods(value, 15)
  },
  { immediate: true }
)

const resolved = computed(() => (selected.value ? resolvePortion(portionText.value, selected.value) : undefined))

/** 份量折算成功才允许提交，折算不出来就追问（DR-47 / DR-49）。 */
const draftFacts = computed<NutritionFacts | undefined>(() => {
  if (!selected.value || resolved.value?.grams === undefined) return undefined
  return factsForGrams(selected.value, resolved.value.grams)
})

const canAdd = computed(() => !!selected.value && !!draftFacts.value)

const entriesByMeal = computed(() =>
  MEALS.map((name) => ({
    name,
    entries: store.intake.filter((entry) => entry.meal === name)
  }))
)

const pendingEntries = computed(() => store.intake.filter((entry) => entry.pendingFlag === 1))

const completeVisible = ref(false)
const completing = ref<IntakeEntry>()
const completePortion = ref('')
const completeFacts = ref<FoodFactsDraft>(emptyFactsDraft())
const completeFood = ref<Food>()
const completeQuery = ref('')
const completeResults = ref<Food[]>([])
const completeBusy = ref(false)
const completeError = ref('')

const completeNeedsFacts = computed(
  () => !!completing.value && !completeFood.value && !hasKnownNutrition(completing.value.foodSnapshot)
)

const completeReview = computed(() => {
  const entry = completing.value
  if (!entry) return undefined
  return reviewIntakeCompletion(entry, {
    food: completeFood.value,
    portionText: completePortion.value,
    factsDraft: completeFacts.value
  })
})

watch(
  () => completeQuery.value,
  async (value) => {
    if (!completeVisible.value) return
    completeResults.value = await searchFoods(value, 8)
  }
)

function initialPortionOf(entry: IntakeEntry): string {
  if (entry.amount.grams !== undefined) return `${fmtNumber(entry.amount.grams)}g`
  const unit = entry.amount.unit?.trim() ?? ''
  if (!unit || unit === '待补全') return ''
  return parsePortionInput(unit) ? unit : ''
}

async function startComplete(entry: IntakeEntry): Promise<void> {
  completing.value = entry
  completePortion.value = initialPortionOf(entry)
  completeFacts.value = emptyFactsDraft()
  completeFood.value = undefined
  completeQuery.value = entry.foodSnapshot.name
  completeResults.value = await searchFoods(entry.foodSnapshot.name, 8)
  completeError.value = ''
  completeVisible.value = true
}

function pickCompleteFood(food: Food): void {
  completeFood.value = food
  completeResults.value = []
  if (!completePortion.value.trim()) {
    completePortion.value = food.unit === '100g' || food.unit === '100ml' ? '100g' : `1${food.unit}`
  }
}

function clearCompleteFood(): void {
  completeFood.value = undefined
}

function setCompleteFact(key: NutrientKey, value: string | number): void {
  completeFacts.value[key] = String(value)
}

async function saveComplete(): Promise<void> {
  const entry = completing.value
  const review = completeReview.value
  if (!entry || !review?.ok || completeBusy.value) return
  completeBusy.value = true
  completeError.value = ''
  try {
    const result = await store.completePendingIntake(entry.id, {
      food: completeFood.value,
      portionText: completePortion.value,
      factsDraft: completeFacts.value
    })
    if (!result.ok) {
      completeError.value = result.error
      return
    }
    completeVisible.value = false
    showToast({
      message: result.warnings.length ? '已补齐；有数值提醒，请核对' : '已补齐，汇总已重算',
      position: 'bottom'
    })
  } catch (cause) {
    completeError.value = `补齐失败：${cause instanceof Error ? cause.message : cause}`
  } finally {
    completeBusy.value = false
  }
}

function pick(food: Food): void {
  selected.value = food
  if (!portionText.value) portionText.value = food.unit === '100g' || food.unit === '100ml' ? '100g' : `1${food.unit}`
}

async function submit(): Promise<void> {
  const food = selected.value
  const amount = resolved.value
  const computedFacts = draftFacts.value
  if (!food || !amount || !computedFacts) return
  busy.value = true
  try {
    await store.addFoodEntry({
      meal: meal.value,
      dish: dish.value.trim() || food.name,
      food,
      amount: { qty: amount.qty, unit: amount.unit, grams: amount.grams },
      computed: computedFacts,
      note: amount.note
    })
    showToast({ message: '已记录', position: 'bottom' })
    selected.value = undefined
    portionText.value = ''
  } catch (cause) {
    showToast({ message: `记录失败：${cause instanceof Error ? cause.message : cause}`, position: 'bottom' })
  } finally {
    busy.value = false
  }
}

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isFinite(parsed) ? undefined : parsed
}

/** 手工录入一律按「每 100 g / 100 ml」写进食物库，和 foods.csv 的口径保持一致。 */
async function saveManual(): Promise<void> {
  const name = manual.value.name.trim()
  const kcal = numberOrUndefined(manual.value.kcal)
  if (!name || kcal === undefined) {
    showToast({ message: '至少要有名称和热量', position: 'bottom' })
    return
  }
  busy.value = true
  try {
    const food = await upsertFood({
      name,
      category: '手工录入',
      unit: manual.value.unit,
      kcal,
      proteinG: numberOrUndefined(manual.value.protein) ?? 0,
      fatG: numberOrUndefined(manual.value.fat) ?? 0,
      carbG: numberOrUndefined(manual.value.carb) ?? 0,
      fiberG: numberOrUndefined(manual.value.fiber) ?? 0,
      sodiumMg: numberOrUndefined(manual.value.sodium) ?? 0,
      source: 'manual',
      sourceNote: '用户在应用内手工录入'
    })
    manualVisible.value = false
    manual.value = { name: '', unit: '100g', kcal: '', protein: '', fat: '', carb: '', fiber: '', sodium: '' }
    pick(food)
    results.value = await searchFoods(food.name, 15)
    showToast({ message: '已存入食物库', position: 'bottom' })
  } finally {
    busy.value = false
  }
}

</script>

<template>
  <div class="panel">
    <div class="segbar">
      <van-tabs v-model:active="meal" shrink>
        <van-tab v-for="name in MEALS" :key="name" :name="name" :title="name" />
      </van-tabs>
    </div>

    <div v-if="pendingEntries.length" class="card card-warn">
      <div class="card-head">
        <h2 class="card-title">待补全（{{ pendingEntries.length }}）</h2>
        <span class="tag">需要处理</span>
      </div>
      <p class="muted">
        一句话记录没算出克数或营养值的条目会先记下来。补上份量（必要时再补每 100 g 的数值）后，
        会按本地口径重算并清掉标记。
      </p>
      <div v-for="entry in pendingEntries" :key="entry.id" class="pending-row">
        <div>
          <div class="entry-name">
            {{ entry.foodSnapshot.name }}
            <span class="tag">待补全</span>
          </div>
          <div class="entry-meta">
            {{ entry.meal }} · {{ entry.amount.unit }}
            <template v-if="!hasKnownNutrition(entry.foodSnapshot)"> · 还没有营养值</template>
          </div>
        </div>
        <van-button size="small" type="primary" plain @click="startComplete(entry)">补齐</van-button>
      </div>
    </div>

    <div class="card">
      <van-field v-model="dish" label="菜品/做法" placeholder="例如：西红柿鸡蛋拌面（可留空）" />
      <van-search v-model="query" placeholder="搜索食物库，如「鸡蛋」「面条」" />
      <div v-if="results.length" class="food-list">
        <div
          v-for="food in results"
          :key="food.id"
          class="food-item"
          :class="{ 'food-item-active': selected?.id === food.id }"
          role="button"
          :aria-pressed="selected?.id === food.id"
          @click="pick(food)"
        >
          <div class="food-item-main">
            <div class="food-item-name">
              {{ food.name }}
              <span v-if="selected?.id === food.id" class="food-item-check" aria-hidden="true">✓</span>
            </div>
            <div class="food-item-meta">
              每 {{ food.unit }}
              <span v-if="food.basisGrams">· 约 {{ fmtNumber(food.basisGrams) }} g</span>
              · 蛋白 {{ fmtNumber(food.proteinG) }} g
            </div>
          </div>
          <div class="food-item-kcal">
            {{ fmtNumber(food.kcal) }}
            <small>kcal</small>
          </div>
        </div>
      </div>
      <p v-else class="empty">没有匹配的食物：换个说法搜，或者手工录入一条。</p>
      <van-button size="small" plain block style="margin-top: 10px" @click="manualVisible = true">
        找不到？手工录入一条
      </van-button>
    </div>

    <div v-if="selected" class="card">
      <h2 class="card-title">{{ selected.name }}</h2>
      <p class="muted">
        基准：{{ selected.unit }} · {{ fmtNumber(selected.kcal) }} kcal · 蛋白
        {{ fmtNumber(selected.proteinG) }} g · 脂肪 {{ fmtNumber(selected.fatG) }} g · 碳水
        {{ fmtNumber(selected.carbG) }} g
      </p>
      <van-field v-model="portionText" label="份量" placeholder="如 200g / 2只(100g) / 一碗" />
      <div v-if="resolved" class="portion-feedback" :class="{ 'portion-warn': !draftFacts }">
        <p class="muted">{{ resolved.note }}</p>
        <div v-if="draftFacts" class="facts-grid">
          <div v-for="key in NUTRIENT_KEYS" :key="key" class="facts-cell">
            <span class="facts-label">{{ NUTRIENT_LABELS[key] }}</span>
            <span class="facts-value">{{ fmtNumber(draftFacts[key]) }} {{ NUTRIENT_UNITS[key] }}</span>
          </div>
        </div>
      </div>
      <van-button type="primary" block :disabled="!canAdd" :loading="busy" @click="submit">
        加入{{ meal }}
      </van-button>
    </div>

    <div class="card">
      <h2 class="card-title">今天已记录</h2>
      <div v-for="group in entriesByMeal" :key="group.name">
        <template v-if="group.entries.length">
          <p class="meal-label">{{ group.name }}</p>
          <div v-for="entry in group.entries" :key="entry.id" class="entry-row">
            <div>
              <div class="entry-name">
                {{ entry.dish }}
                <span v-if="entry.pendingFlag === 1" class="tag">待补全</span>
              </div>
              <div class="entry-meta">
                {{ entry.foodSnapshot.name }} · {{ entry.amount.qty }}{{ entry.amount.unit }}
                <template v-if="entry.amount.grams">（{{ fmtNumber(entry.amount.grams) }} g）</template>
              </div>
            </div>
            <div class="entry-right">
              <span class="entry-kcal">{{ fmtNumber(entry.computed.kcal) }} kcal</span>
              <van-button
                v-if="entry.pendingFlag === 1"
                size="mini"
                type="primary"
                plain
                @click="startComplete(entry)"
              >
                补齐
              </van-button>
              <van-button size="mini" plain type="danger" @click="store.removeIntakeEntry(entry.id)">
                删除
              </van-button>
            </div>
          </div>
        </template>
      </div>
      <p v-if="!store.intake.length" class="muted">还没有记录。</p>
    </div>

    <van-popup v-model:show="manualVisible" position="bottom" round :style="{ padding: '16px' }">
      <h2 class="card-title">手工录入食物</h2>
      <p class="muted">数值按「每 100 g / 100 ml」，与工作区 foods.csv 口径一致。</p>
      <van-field v-model="manual.name" label="名称" placeholder="如：食堂番茄炒蛋" />
      <van-field v-model="manual.kcal" label="热量" type="number" placeholder="kcal" />
      <van-field v-model="manual.protein" label="蛋白" type="number" placeholder="g" />
      <van-field v-model="manual.fat" label="脂肪" type="number" placeholder="g" />
      <van-field v-model="manual.carb" label="碳水" type="number" placeholder="g" />
      <van-field v-model="manual.fiber" label="纤维" type="number" placeholder="g" />
      <van-field v-model="manual.sodium" label="钠" type="number" placeholder="mg" />
      <van-button type="primary" block :loading="busy" style="margin-top: 12px" @click="saveManual">
        保存并选用
      </van-button>
    </van-popup>

    <van-popup
      v-model:show="completeVisible"
      position="bottom"
      round
      :style="{ padding: '16px', maxHeight: '86vh', overflowY: 'auto' }"
    >
      <template v-if="completing">
        <h2 class="card-title">补齐「{{ completing.foodSnapshot.name }}」</h2>
        <p class="muted">
          这条是 {{ completing.meal }} · {{ completing.amount.unit }}。补上份量后按本地口径重算；
          模型不参与计算。
        </p>

        <p class="complete-label">从食物库选（可选）</p>
        <van-field v-model="completeQuery" placeholder="搜食物库；选中会用它的数值替换这条记录" clearable />
        <div v-if="completeResults.length" class="food-list complete-results">
          <div v-for="food in completeResults" :key="food.id" class="food-item" @click="pickCompleteFood(food)">
            <div class="food-item-main">
              <div class="food-item-name">{{ food.name }}</div>
              <div class="food-item-meta">每 {{ food.unit }} · 蛋白 {{ fmtNumber(food.proteinG) }} g</div>
            </div>
            <div class="food-item-kcal">
              {{ fmtNumber(food.kcal) }}
              <small>kcal</small>
            </div>
          </div>
        </div>
        <p v-if="completeFood" class="muted">
          将使用「{{ completeFood.name }}」的数值（每 {{ completeFood.unit }}）。
          <van-button size="mini" plain @click="clearCompleteFood">改用原记录</van-button>
        </p>

        <van-field v-model="completePortion" label="份量" placeholder="如 200g / 2只 / 一碗" />

        <div v-if="completeNeedsFacts">
          <p class="muted">
            这条记录还没有营养值。按包装标签 / 厨房秤填每
            {{ completing.foodSnapshot.unit === '100ml' ? '100 ml' : '100 g' }} 的六项；
            只补这一条，不改食物库。
          </p>
          <van-field
            v-for="key in NUTRIENT_KEYS"
            :key="key"
            :model-value="completeFacts[key]"
            :label="`${NUTRIENT_LABELS[key]}（${NUTRIENT_UNITS[key]}）`"
            type="number"
            @update:model-value="(value) => setCompleteFact(key, value)"
          />
        </div>

        <div v-if="completeReview?.ok" class="complete-preview">
          <p class="muted">
            补齐后 ≈ {{ fmtNumber(completeReview.computed?.kcal) }} kcal
            <template v-if="completeReview.amount?.grams !== undefined">
              · {{ fmtNumber(completeReview.amount.grams) }} g
            </template>
          </p>
          <div class="facts-grid">
            <div v-for="key in NUTRIENT_KEYS" :key="key" class="facts-cell">
              <span class="facts-label">{{ NUTRIENT_LABELS[key] }}</span>
              <span class="facts-value">
                {{ fmtNumber(completeReview.computed?.[key] ?? 0) }} {{ NUTRIENT_UNITS[key] }}
              </span>
            </div>
          </div>
        </div>

        <p v-if="completeReview?.portionNote" class="muted">{{ completeReview.portionNote }}</p>
        <p v-if="completeReview && !completeReview.ok && completePortion.trim()" class="muted warn-text">
          {{ completeReview.error }}
        </p>
        <ul v-if="completeReview?.warnings.length" class="hint-list">
          <li v-for="warning in completeReview.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <p v-if="completeError" class="muted warn-text">{{ completeError }}</p>

        <div class="actions">
          <van-button
            type="primary"
            block
            :disabled="!completeReview?.ok"
            :loading="completeBusy"
            @click="saveComplete"
          >
            保存补齐
          </van-button>
          <van-button plain block @click="completeVisible = false">取消</van-button>
        </div>
      </template>
    </van-popup>
</div>
</template>

<style scoped>
.segbar {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 4px 10px;
}

.food-list {
  max-height: 260px;
  overflow-y: auto;
  margin-top: 4px;
}

.food-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 44px;
  padding: 8px 6px;
  border-bottom: 1px dashed var(--border);
  cursor: pointer;
}

.food-item:last-child {
  border-bottom: none;
}

.food-item-active {
  background: var(--brand-soft);
  border-radius: var(--radius-sm);
  box-shadow: inset 3px 0 0 var(--brand);
}

.food-item-name {
  font-size: 14px;
}

.food-item-check {
  margin-left: 6px;
  color: var(--brand);
}

.food-item-meta {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 2px;
}

.food-item-kcal {
  flex-shrink: 0;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.food-item-kcal small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
}

.meal-label {
  margin: 12px 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand);
}

.meal-label:first-child {
  margin-top: 0;
}

.entry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.entry-row:last-child {
  border-bottom: none;
}

.entry-name {
  font-size: 14px;
}

.entry-meta {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 2px;
}

.portion-feedback {
  padding: 8px 0;
}

.portion-warn {
  color: var(--warn);
}

.facts-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 8px;
}

.facts-cell {
  display: flex;
  flex-direction: column;
  background: var(--brand-soft);
  border-radius: 8px;
  padding: 6px 8px;
}

.facts-label {
  color: var(--text-muted);
  font-size: 12px;
}

.facts-value {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.entry-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.entry-kcal {
  font-variant-numeric: tabular-nums;
  font-size: 14px;
}

.pending-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.pending-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.complete-label {
  margin: 12px 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand);
}

.complete-results {
  max-height: 180px;
}

.complete-preview {
  margin-top: 10px;
}
</style>
