<script setup lang="ts">
/**
 * 「记录」tab 的容器（M1 / M2 / M3）。
 *
 * 顶部子 tab 区分三个记录面板：饮食 / 训练 / 身体。**日期由这里统一持有**，
 * 子 tab 之间切换不会丢掉选中的日期；三个面板只从 store 读数据，各自不再管路由与加载。
 *
 * 选中项以路由参数为准（`/log/diet`、`/log/workout`、`/log/body`），
 * 这样从「今日」的快捷按钮进来能直接落在对应子 tab，浏览器前进/后退也一致。
 */

import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import DateNav from '@/components/DateNav.vue'
import DietPanel from '@/pages/LogDietPage.vue'
import WorkoutPanel from '@/pages/LogWorkoutPage.vue'
import BodyPanel from '@/pages/LogBodyPage.vue'
import { useDayStore } from '@/store/day'
import { todayIso } from '@/app/date'

type LogKind = 'diet' | 'workout' | 'body'

const KINDS: { name: LogKind; title: string; hint: string }[] = [
  { name: 'diet', title: '饮食', hint: '选食物 → 填份量 → 确认；换算与热量全部本地计算。' },
  { name: 'workout', title: '训练', hint: '容量负荷与有氧消耗本地计算，不让模型算数。' },
  { name: 'body', title: '身体', hint: '晨起空腹称重最稳定；没称就留空，不用昨天的值补。' }
]

const route = useRoute()
const router = useRouter()
const store = useDayStore()

function isKind(value: unknown): value is LogKind {
  return value === 'diet' || value === 'workout' || value === 'body'
}

const kind = computed<LogKind>(() => (isKind(route.params.kind) ? route.params.kind : 'diet'))
const current = computed(() => KINDS.find((item) => item.name === kind.value) ?? KINDS[0])

const activeTab = computed({
  get: () => kind.value,
  set: (next: LogKind) => {
    if (next !== kind.value) void router.replace({ name: 'log', params: { kind: next } })
  }
})

onMounted(() => {
  void store.load(todayIso())
})
</script>

<template>
  <section class="page">
    <AppHeader title="记录" :subtitle="current.hint" />

    <div class="hub-bar">
      <van-tabs v-model:active="activeTab" shrink>
        <van-tab v-for="item in KINDS" :key="item.name" :name="item.name" :title="item.title" />
      </van-tabs>
      <van-button size="small" plain type="primary" class="quick-entry" @click="router.push('/log/quick')">
        一句话 / 拍照
      </van-button>
    </div>

    <DateNav :date="store.date" @update:date="store.load" />

    <DietPanel v-if="kind === 'diet'" />
    <WorkoutPanel v-else-if="kind === 'workout'" />
    <BodyPanel v-else />
  </section>
</template>

<style scoped>
.hub-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 4px 10px;
}

.hub-bar :deep(.van-tabs__wrap) {
  height: auto;
}

.quick-entry {
  flex-shrink: 0;
}
</style>
