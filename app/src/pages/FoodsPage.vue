<script setup lang="ts">
/**
 * 食物库（T4.4 / M4 FR-402 / FR-408 / FR-411 / FR-412）。
 *
 * 三件事：
 * 1. **检索与来源筛选**（FR-402 / FR-411）：按名称搜、按来源（内置 / 模型 / 手工）与分类筛，
 *    全部本地完成，不消耗 token；
 * 2. **疑似重复提醒**（FR-408）：去括号后同名的一组列在一起，数值是否一致也说清楚，
 *    但**绝不自动合并** —— 括号里的生熟 / 全脂脱脂往往正是区别；
 * 3. **停用与删除**（FR-412）：被记录引用过的条目不能删除，只能停用；删除前二次确认，
 *    且真正的判据在 `application/foodAdmin.ts` 里（界面把按钮禁掉只是顺手）。
 *
 * 停用的语义要讲明白：**不删除任何历史数值**。摄入条目存的是食物快照（DR-02），
 * 停用只是让它不再出现在检索与新增候选里。
 */

import { computed, onMounted, ref, watch } from 'vue'
import { showDialog, showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import ChipSelect from '@/components/ChipSelect.vue'
import { buildFoodOverview, deleteFood, setDisabled, SOURCE_LABELS, type FoodOverview } from '@/application/foodAdmin'
import { baseNameOf, normalizeFoodName } from '@/domain/foodName'
import { fmtNumber } from '@/domain/format'
import type { Food } from '@/domain/types'

/** 每屏先渲染这么多条，剩下的按需展开（库会随着模型补全长大）。 */
const PAGE_SIZE = 30

const overview = ref<FoodOverview>()
const loaded = ref(false)
const busyId = ref('')
const errorMessage = ref('')
const query = ref('')
const sourceFilter = ref('全部')
const categoryFilter = ref('全部')
const visibleCount = ref(PAGE_SIZE)

const collator = new Intl.Collator('zh-Hans-CN')

const sourceOptions = computed(() => ['全部', ...Object.values(SOURCE_LABELS), '已停用'])

const categoryOptions = computed(() => [
  '全部',
  ...[...new Set((overview.value?.foods ?? []).map((food) => food.category))].sort((a, b) => collator.compare(a, b))
])

const filtered = computed(() => {
  const rows = overview.value?.foods ?? []
  const keyword = normalizeFoodName(query.value)
  const raw = query.value.trim()
  return rows.filter((food) => {
    if (sourceFilter.value === '已停用') {
      if (food.disabledFlag !== 1) return false
    } else {
      if (food.disabledFlag === 1) return false
      if (sourceFilter.value !== '全部' && SOURCE_LABELS[food.source] !== sourceFilter.value) return false
    }
    if (categoryFilter.value !== '全部' && food.category !== categoryFilter.value) return false
    if (keyword && !food.nameNorm.includes(keyword) && !food.name.includes(raw)) return false
    return true
  })
})

const visible = computed(() => filtered.value.slice(0, visibleCount.value))

async function load(): Promise<void> {
  overview.value = await buildFoodOverview()
  loaded.value = true
}

onMounted(load)

// 改了筛选条件就从第一屏重新开始：否则「搜索后只剩 3 条，却停在上一屏的滚动位置」很迷惑
watch([query, sourceFilter, categoryFilter], () => {
  visibleCount.value = PAGE_SIZE
})

function referencesOf(food: Food): number {
  return overview.value?.references.get(food.id) ?? 0
}

function factsLine(food: Food): string {
  return [
    `${fmtNumber(food.kcal)} kcal`,
    `蛋白 ${fmtNumber(food.proteinG)}`,
    `脂肪 ${fmtNumber(food.fatG)}`,
    `碳水 ${fmtNumber(food.carbG)}`,
    `纤维 ${fmtNumber(food.fiberG)}`,
    `钠 ${fmtNumber(food.sodiumMg)}`
  ].join(' · ')
}

async function toggleDisabled(food: Food): Promise<void> {
  busyId.value = food.id
  errorMessage.value = ''
  const disabled = food.disabledFlag !== 1
  try {
    const outcome = await setDisabled(food.id, disabled)
    if (!outcome.ok) {
      errorMessage.value = outcome.reason
      return
    }
    await load()
    showToast({ message: disabled ? '已停用，检索里不再出现' : '已恢复', position: 'bottom' })
  } finally {
    busyId.value = ''
  }
}

async function remove(food: Food): Promise<void> {
  try {
    await showDialog({
      title: `删除「${food.name}」`,
      message: `这条食物还没有被任何记录用过，可以删掉。删掉后要再记同一样东西，得重新录入或再问一次模型。`
    })
  } catch {
    return
  }
  busyId.value = food.id
  errorMessage.value = ''
  try {
    const outcome = await deleteFood(food.id)
    if (!outcome.ok) {
      // 从渲染列表到点确认之间用户可能又记了一条：这里如实说出条数并让他改用停用
      errorMessage.value = outcome.reason
      await load()
      return
    }
    await load()
    showToast({ message: '已删除', position: 'bottom' })
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader title="食物库" subtitle="检索与治理都在本机完成，不消耗 token" back />

    <div class="card">
      <h2 class="card-title">概况</h2>
      <div class="kv">
        <span class="kv-key">条目</span>
        <span class="kv-value">
          共 {{ overview?.stats.total ?? 0 }} 条 · 内置 {{ overview?.stats.bySource.seed ?? 0 }} · 模型
          {{ overview?.stats.bySource.llm ?? 0 }} · 手工 {{ overview?.stats.bySource.manual ?? 0 }}
        </span>
      </div>
      <div class="kv">
        <span class="kv-key">状态</span>
        <span class="kv-value">
          已停用 {{ overview?.stats.disabled ?? 0 }} 条 · 被记录引用过 {{ overview?.stats.referenced ?? 0 }} 条
        </span>
      </div>
      <p class="muted">
        被记录引用过的条目<strong>不能删除</strong>（FR-412），只能停用 —— 历史记录里存的是当时那份营养快照，
        删条目不会让它们变形，但会让「这条数值哪来的」查不到出处。
      </p>
    </div>

    <div class="card">
      <h2 class="card-title">筛选</h2>
      <van-field v-model="query" placeholder="按名称搜索（本地，不联网）" clearable />
      <div class="filter-row">
        <span class="filter-label">来源</span>
        <ChipSelect v-model="sourceFilter" :options="sourceOptions" aria-label="按来源筛选" />
      </div>
      <div class="filter-row">
        <span class="filter-label">分类</span>
        <ChipSelect v-model="categoryFilter" :options="categoryOptions" aria-label="按分类筛选" />
      </div>
      <p class="muted">
        命中 {{ filtered.length }} 条<template v-if="sourceFilter === '已停用'">（只看已停用）</template>。
      </p>
    </div>

    <div v-if="overview?.duplicates.length" class="card card-warn">
      <h2 class="card-title">疑似重复（{{ overview.duplicates.length }} 组）</h2>
      <p class="muted">
        去掉括号后名字相同的条目。括号里的生熟 / 全脂脱脂往往<strong>正是区别</strong>，所以这里只提醒、不自动合并：
        看清数值再决定留哪条、停用哪条。
      </p>
      <div v-for="group in overview.duplicates" :key="group.key" class="dup-group">
        <div class="dup-head">
          <span class="dup-name">{{ baseNameOf(group.foods[0].name) }}</span>
          <span class="tag">{{ group.identicalFacts ? '数值完全相同' : '数值不同' }}</span>
        </div>
        <p class="muted">
          {{
            group.identicalFacts
              ? '六项数值完全一致，基本可以确认是同一条：留一条、把其余的停用即可。'
              : '主名相同但数值不同：先确认括号里的限定语是不是真的区别，别直接合并。'
          }}
        </p>
        <ul class="hint-list">
          <li v-for="food in group.foods" :key="food.id">
            {{ food.name }} · {{ fmtNumber(food.kcal) }} kcal · {{ food.unit }}
            <span class="muted">
              （{{ SOURCE_LABELS[food.source] }}<template v-if="food.disabledFlag === 1"> · 已停用</template>）
            </span>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="!loaded" class="card">
      <p class="muted">读取中…</p>
    </div>

    <div v-else-if="!filtered.length" class="card">
      <p class="empty">没有符合条件的条目。</p>
    </div>

    <div v-else class="card">
      <h2 class="card-title">条目（{{ visible.length }} / {{ filtered.length }}）</h2>
      <div v-for="food in visible" :key="food.id" class="food-row">
        <div class="food-name">
          {{ food.name }}
          <span class="tag">{{ SOURCE_LABELS[food.source] }}</span>
          <span v-if="food.disabledFlag === 1" class="tag">已停用</span>
        </div>
        <div class="food-meta">
          {{ food.category }} · 每 {{ food.unit }}
          <span v-if="food.cookedState"> · {{ food.cookedState }}</span>
        </div>
        <div class="food-meta num">{{ factsLine(food) }}</div>
        <div v-if="food.sourceNote || food.edibleNote" class="food-meta">
          {{ [food.sourceNote, food.edibleNote].filter(Boolean).join(' · ') }}
        </div>
        <div class="food-meta">
          <span v-if="referencesOf(food)">被 {{ referencesOf(food) }} 条记录引用过</span>
          <span v-else>还没有记录用过</span>
        </div>
        <div class="food-actions">
          <van-button
            size="small"
            plain
            :loading="busyId === food.id"
            @click="toggleDisabled(food)"
          >
            {{ food.disabledFlag === 1 ? '恢复' : '停用' }}
          </van-button>
          <van-button
            size="small"
            plain
            type="danger"
            :disabled="referencesOf(food) > 0"
            :loading="busyId === food.id"
            @click="remove(food)"
          >
            删除
          </van-button>
        </div>
        <p v-if="referencesOf(food)" class="muted">
          被引用过，删不掉（FR-412）—— 用「停用」让它不再出现在检索里。
        </p>
      </div>
      <div v-if="filtered.length > visible.length" class="actions">
        <van-button plain block @click="visibleCount += PAGE_SIZE">
          显示更多（还有 {{ filtered.length - visible.length }} 条）
        </van-button>
      </div>
    </div>

    <p v-if="errorMessage" class="muted warn-text">{{ errorMessage }}</p>
  </section>
</template>

<style scoped>
.filter-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.filter-label {
  color: var(--text-muted);
  font-size: 13px;
}

.dup-group {
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.dup-group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.dup-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dup-name {
  font-size: 15px;
  font-weight: 600;
}

.food-row {
  padding: 10px 0;
  border-bottom: 1px dashed var(--border);
}

.food-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.food-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
}

.food-meta {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
}

.food-meta.num {
  font-variant-numeric: tabular-nums;
}

.food-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
