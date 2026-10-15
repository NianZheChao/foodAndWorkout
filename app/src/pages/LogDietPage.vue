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
import { factsForGrams, NUTRIENT_KEYS, NUTRIENT_LABELS, NUTRIENT_UNITS } from '@/domain/nutrition'
import { resolvePortion } from '@/domain/portion'
import { searchFoods, upsertFood } from '@/data/repositories/foods'
import { fmtNumber } from '@/domain/format'
import type { Food, Meal, NutritionFacts } from '@/domain/types'

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
  <section class="page">
    <van-tabs v-model:active="meal" shrink>
      <van-tab v-for="name in MEALS" :key="name" :name="name" :title="name" />
    </van-tabs>

    <div class="card">
      <van-field v-model="dish" label="菜品/做法" placeholder="例如：西红柿鸡蛋拌面（可留空）" />
      <van-search v-model="query" placeholder="搜索食物库，如「鸡蛋」「面条」" />
      <div v-if="results.length" class="food-list">
        <div
          v-for="food in results"
          :key="food.id"
          class="food-item"
          :class="{ 'food-item-active': selected?.id === food.id }"
          @click="pick(food)"
        >
          <div class="food-item-name">{{ food.name }}</div>
          <div class="food-item-meta">
            {{ fmtNumber(food.kcal) }} kcal / {{ food.unit }}
            <span v-if="food.basisGrams">（约 {{ fmtNumber(food.basisGrams) }} g）</span>
          </div>
        </div>
      </div>
      <van-empty v-else description="没有匹配的食物" image-size="60" />
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
  </section>
</template>

<style scoped>
.food-list {
  max-height: 260px;
  overflow-y: auto;
}

.food-item {
  padding: 8px 4px;
  border-bottom: 1px dashed var(--border);
  cursor: pointer;
}

.food-item-active {
  background: var(--brand-soft);
}

.food-item-name {
  font-size: 14px;
}

.food-item-meta {
  color: var(--text-muted);
  font-size: 12px;
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

.meal-label {
  margin: 12px 0 4px;
  font-size: 13px;
  color: var(--brand);
}

.entry-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.entry-name {
  font-size: 14px;
}

.entry-meta {
  color: var(--text-muted);
  font-size: 12px;
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
</style>
