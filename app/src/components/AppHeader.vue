<script setup lang="ts">
/**
 * 页面标题条 + **统一的树状路径**。
 *
 * 底部 tab 是「域」（今日 / 记录 / 分析 / 我的 / 设置），本组件按 `app/nav.ts` 的导航树
 * 自动渲染两样东西，页面自己一行都不用写：
 *
 * 1. `.domain-nav`：本域导航条（`navLocation().chips`）。域根页上它是「本域目录」，
 *    二级页上是「同层还有谁」—— 谁都不再是只有唯一入口的孤岛（`/coach` 以前就是这样）。
 * 2. `.crumbs`：面包屑，**只在层级 ≥ 3 时出现**（如 `分析 › 报告 › 报告详情`）；
 *    两级页面（域 + 页面）用高亮的那颗格子表达就够了，不再重复一遍。
 *
 * 退路也在这里：有历史就 `router.back()`，直接从外部链接进来（没有历史）就回今日页，
 * 不会出现「点返回没反应」。
 */

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { navLocation } from '@/app/nav'

withDefaults(defineProps<{ title: string; subtitle?: string; back?: boolean }>(), {
  subtitle: '',
  back: false
})

const route = useRoute()
const router = useRouter()

const here = computed(() =>
  navLocation(route.path, typeof route.name === 'string' ? route.name : null)
)

function go(to: string): void {
  if (route.path !== to) void router.push(to)
}

function goBack(): void {
  if (window.history.length > 1) router.back()
  else void router.push('/today')
}
</script>

<template>
  <div class="page-header">
    <div class="page-head">
      <button v-if="back" type="button" class="back-btn" aria-label="返回" @click="goBack">‹</button>
      <div>
        <p v-if="here.crumbs.length" class="crumbs">
          <template v-for="(crumb, index) in here.crumbs" :key="`${crumb.label}-${index}`">
            <span v-if="index" class="crumb-sep">›</span>
            <button
              v-if="crumb.path"
              type="button"
              class="crumb-link"
              @click="go(crumb.path)"
            >{{ crumb.label }}</button>
            <span v-else class="crumb-here">{{ crumb.label }}</span>
          </template>
        </p>
        <h1 class="page-title">{{ title }}</h1>
        <p v-if="subtitle" class="page-subtitle">{{ subtitle }}</p>
      </div>
      <slot />
    </div>

    <nav v-if="here.chips.length > 1" class="domain-nav" aria-label="本页所在分支">
      <button
        v-for="chip in here.chips"
        :key="chip.path"
        type="button"
        class="nav-chip"
        :class="{ 'nav-chip--on': chip.active }"
        :aria-current="chip.active ? 'page' : undefined"
        @click="go(chip.path)"
      >{{ chip.label }}</button>
    </nav>
  </div>
</template>