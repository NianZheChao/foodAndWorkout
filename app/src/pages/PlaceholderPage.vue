<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <section class="page">
    <h1 class="page-title">{{ route.meta.title }}</h1>
    <p class="page-subtitle">待实现</p>
    <div class="card">
      <p class="muted">
        本页对应需求编号 <span class="tag">{{ route.meta.spec }}</span>，实现计划见
        <code>docs/pwa-design.md</code> §13。
      </p>
    </div>
  </section>
</template>