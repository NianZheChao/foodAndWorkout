<script setup lang="ts">
/**
 * 还没实现的页面（阶段 3 / 4 的落点）。
 *
 * 保留这个页面而不是隐藏入口：底部 tab 与「更多」里点到它时能得到一句真话
 * （「待实现」+ 需求编号），而不是白屏或 404。
 */
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'

const route = useRoute()
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
        <van-button plain type="primary" block @click="$router.push('/today')">回今日页</van-button>
      </div>
    </div>
  </section>
</template>
