<script setup lang="ts">
/**
 * 页面标题条。
 *
 * 底部 tabbar 只有五个入口，二级页面（目标 / 档案 / 模型设置 / 数据 …）全靠这里给一条
 * 明确的退路：有历史就 `router.back()`，直接从外部链接进来（没有历史）就回今日页，
 * 不会出现「点返回没反应」。
 */

import { useRouter } from 'vue-router'

withDefaults(defineProps<{ title: string; subtitle?: string; back?: boolean }>(), {
  subtitle: '',
  back: false
})

const router = useRouter()

function goBack(): void {
  if (window.history.length > 1) router.back()
  else void router.push('/today')
}
</script>

<template>
  <div class="page-head">
    <button v-if="back" type="button" class="back-btn" aria-label="返回" @click="goBack">‹</button>
    <div>
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="subtitle" class="page-subtitle">{{ subtitle }}</p>
    </div>
    <slot />
  </div>
</template>
