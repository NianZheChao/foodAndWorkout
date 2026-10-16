<script setup lang="ts">
/**
 * 「记录」域的根页（M1 / M2 / M3），域内三块面板共用它：饮食 / 训练 / 身体。
 * **日期由这里统一持有**，页面之间切换不会丢掉选中的日期；三个面板只从 store 读数据，
 * 各自不再管路由与加载。
 *
 * 同级切换（含「一句话记录」「食物库」）交给页头那条由 `app/nav.ts` 渲染的域导航条 ——
 * 这里原本自带一套 `van-tabs` + 「一句话 / 拍照」按钮，等于每个域各写一份导航，改一处就得翻五个文件。
 *
 * 当前面板以路由为准（`/log/diet`、`/log/workout`、`/log/body`），
 * 这样从「今日」的快捷按钮进来能直接落在对应面板，浏览器前进/后退也一致。
 */

import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import DateNav from '@/components/DateNav.vue'
import DietPanel from '@/pages/LogDietPage.vue'
import WorkoutPanel from '@/pages/LogWorkoutPage.vue'
import BodyPanel from '@/pages/LogBodyPage.vue'
import { useDayStore } from '@/store/day'
import { todayIso } from '@/app/date'

type LogKind = 'diet' | 'workout' | 'body'

const KINDS: { name: LogKind; hint: string }[] = [
  { name: 'diet', hint: '选食物 → 填份量 → 确认；换算与热量全部本地计算。' },
  { name: 'workout', hint: '容量负荷与有氧消耗本地计算，不让模型算数。' },
  { name: 'body', hint: '晨起空腹称重最稳定；没称就留空，不用昨天的值补。' }
]

const route = useRoute()
const store = useDayStore()

function isKind(value: unknown): value is LogKind {
  return value === 'diet' || value === 'workout' || value === 'body'
}

const kind = computed<LogKind>(() => (isKind(route.params.kind) ? route.params.kind : 'diet'))
const current = computed(() => KINDS.find((item) => item.name === kind.value) ?? KINDS[0])

onMounted(() => {
  void store.load(todayIso())
})
</script>

<template>
  <section class="page">
    <AppHeader title="记录" :subtitle="current.hint" />

    <DateNav :date="store.date" @update:date="store.load" />

    <DietPanel v-if="kind === 'diet'" />
    <WorkoutPanel v-else-if="kind === 'workout'" />
    <BodyPanel v-else />
  </section>
</template>