<script setup lang="ts">
/**
 * 还没实现的页面（阶段 3 / 4 的落点）。
 *
 * 保留这个页面而不是隐藏入口：底部 tab 与「更多」里点到它时能得到一句真话
 * （「待实现」+ 需求编号），而不是白屏或 404。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'

const route = useRoute()

/**
 * 这些页整体还没做，但**已经能用的东西不能再被埋掉**：例如「设置」页整体是占位，
 * 模型设置却早就做完了 —— 二级入口必须留一条（2026-10-15 踩过：重排今日页时
 * 顺手删掉了模型设置的老入口，结果全应用再没有地方能进模型设置）。
 */
const REAL_ENTRIES: Record<string, { label: string; to: string }[]> = {
  '/settings': [{ label: '模型设置', to: '/settings/model' }]
}

const entries = computed(() => REAL_ENTRIES[route.path] ?? [])
</script>

<template>
  <section class="page">
    <AppHeader :title="String(route.meta.title)" subtitle="这部分还没做，下面是它的需求编号。" back />
    <div class="card">
      <p class="muted">
        本页对应需求编号 <span class="tag">{{ route.meta.spec }}</span>，实现计划见
        <code>docs/pwa-design.md</code> §13。
      </p>
      <div class="actions">
        <van-button
          v-for="entry in entries"
          :key="entry.to"
          type="primary"
          block
          @click="$router.push(entry.to)"
        >
          {{ entry.label }}
        </van-button>
        <van-button plain type="primary" block @click="$router.push('/today')">回今日页</van-button>
      </div>
    </div>
  </section>
</template>
