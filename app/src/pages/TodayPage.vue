<script setup lang="ts">
/** 今日（M0）：一眼看完今天的状态，并进入记录流程。 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDayStore } from '@/store/day'
import { fmtNumber } from '@/domain/format'
import { formatDateCn, todayIso } from '@/app/date'
import { db, SCHEMA_VERSION } from '@/data/db'
import { countFoods } from '@/data/repositories/foods'
import { countOpenOps } from '@/data/repositories/pendingOps'
import { META_KEYS, getMeta } from '@/data/meta'

const router = useRouter()
const store = useDayStore()

const foodCount = ref(0)
const queueCount = ref(0)
const seedVersion = ref('-')

onMounted(async () => {
  await store.load(todayIso())
  foodCount.value = await countFoods()
  queueCount.value = await countOpenOps()
  seedVersion.value = (await getMeta<string>(META_KEYS.seedVersion)) ?? '-'
})

const kcalRow = computed(() => store.summaryRows.find((row) => row.key === 'kcal'))
const proteinRow = computed(() => store.summaryRows.find((row) => row.key === 'proteinG'))

const weightText = computed(() =>
  store.day?.weightAmKg === undefined ? '未称' : `${fmtNumber(store.day.weightAmKg)} kg`
)

const trainingText = computed(() => {
  if (store.summary.training.isRestDay) return '休息日'
  return `${fmtNumber(store.summary.training.minutes)} 分钟 · ${store.summary.training.sets} 组`
})
</script>

<template>
  <section class="page">
    <h1 class="page-title">薄肌计划</h1>
    <p class="page-subtitle">{{ formatDateCn(store.date) }} · 数据全部保存在本机</p>

    <div class="card">
      <div class="stat-row">
        <div class="stat">
          <span class="stat-label">热量</span>
          <span class="stat-value">
            {{ fmtNumber(kcalRow?.intake ?? 0) }}
            <small v-if="kcalRow?.target">/ {{ fmtNumber(kcalRow.target) }}</small>
            <small v-else>kcal</small>
          </span>
        </div>
        <div class="stat">
          <span class="stat-label">蛋白</span>
          <span class="stat-value">
            {{ fmtNumber(proteinRow?.intake ?? 0) }}
            <small v-if="proteinRow?.target">/ {{ fmtNumber(proteinRow.target) }} g</small>
            <small v-else>g</small>
          </span>
        </div>
        <div class="stat">
          <span class="stat-label">晨重</span>
          <span class="stat-value">{{ weightText }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">训练</span>
          <span class="stat-value">{{ trainingText }}</span>
        </div>
      </div>
      <p v-if="!store.hasTargets" class="muted">还没有目标值，去「目标」页做一次首次校准。</p>
      <p v-if="store.summary.incomplete" class="muted">有 {{ store.pendingCount }} 条记录待补全营养数值。</p>
    </div>

    <div class="quick-grid">
      <van-button type="primary" block @click="router.push('/log/diet')">记饮食</van-button>
      <van-button plain type="primary" block @click="router.push('/log/workout')">记训练</van-button>
      <van-button plain type="primary" block @click="router.push('/log/body')">记身体</van-button>
      <van-button plain type="primary" block @click="router.push('/log/quick')">一句话记录</van-button>
      <van-button plain type="primary" block @click="router.push('/summary')">当日汇总</van-button>
    </div>

    <div v-if="store.summary.hints.length" class="card">
      <h2 class="card-title">今天要注意</h2>
      <ul class="hint-list">
        <li v-for="hint in store.summary.hints" :key="hint">{{ hint }}</li>
      </ul>
    </div>

    <div class="card">
      <h2 class="card-title">本地数据</h2>
      <div class="kv">
        <span class="kv-key">数据库 schema</span>
        <span class="kv-value">v{{ db.verno }} / 目标 v{{ SCHEMA_VERSION }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">食物库条目</span>
        <span class="kv-value">{{ foodCount }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">种子库版本</span>
        <span class="kv-value">{{ seedVersion }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">待办队列</span>
        <span class="kv-value">{{ queueCount }}</span>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">还没有的内容</h2>
      <p class="muted">
        一句话 / 拍照记录与模型设置已经可用；周报 / 月报、推荐与校准向导对应
        <code>docs/pwa-design.md</code> §13 的阶段 3。
      </p>
      <div class="link-grid">
        <van-button size="small" plain block @click="router.push('/settings/model')">模型设置</van-button>
        <van-button size="small" plain block @click="router.push('/foods')">食物库</van-button>
        <van-button size="small" plain block @click="router.push('/log/quick')">拍照记录</van-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stat-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--brand-soft);
  border-radius: 10px;
  padding: 10px;
}

.stat-label {
  color: var(--text-muted);
  font-size: 12px;
}

.stat-value {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.stat-value small {
  color: var(--text-muted);
  font-size: 12px;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}

.link-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 10px;
}

.hint-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
}
</style>
