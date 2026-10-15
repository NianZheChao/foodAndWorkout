<script setup lang="ts">
/**
 * ECharts 薄封装：只负责挂载 / 更新 / 自适应。
 *
 * 渲染器固定用 SVG —— 不依赖 canvas，jsdom 里也能跑，低端安卓上缩放不掉帧。
 * 图表只是「把本地算好的数画出来」，所有数值仍由 `domain/` 产出。
 * 初始化失败时降级为一句提示，不阻塞页面（下方表格里有同样的数据）。
 */

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsType, ComposeOption } from 'echarts/core'
import type { BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from 'echarts/charts'
import type {
  GridComponentOption,
  LegendComponentOption,
  MarkLineComponentOption,
  TooltipComponentOption
} from 'echarts/components'

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, SVGRenderer])

export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | MarkLineComponentOption
  | TooltipComponentOption
>

const props = withDefaults(
  defineProps<{ option: ChartOption; height?: string; label?: string }>(),
  { height: '220px', label: '图表' }
)

const holder = ref<HTMLElement>()
const failed = ref(false)
let chart: EChartsType | undefined

/**
 * jsdom（单元测试环境）没有 canvas，zrender 量文字宽高时会刷一堆「not implemented」。
 * 那里本来也没有布局尺寸，直接跳过绘图：页面下方的表格用的是同一份本地计算。
 */
const canRender = typeof navigator === 'undefined' || !/jsdom/i.test(navigator.userAgent)

function render(): void {
  if (!holder.value || !canRender) return
  try {
    chart ??= echarts.init(holder.value, undefined, { renderer: 'svg' })
    chart.setOption(props.option, true)
    failed.value = false
  } catch {
    // 浏览器太旧或环境不支持时留白，不把整页拖垮
    failed.value = true
  }
}

function resize(): void {
  chart?.resize()
}

onMounted(() => {
  render()
  window.addEventListener('resize', resize)
})

watch(() => props.option, render, { deep: true })

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = undefined
})
</script>

<template>
  <div class="chart-wrap" :style="{ height }">
    <div v-show="!failed" ref="holder" class="chart" role="img" :aria-label="label" />
    <p v-if="failed" class="muted">这一台设备没能画出图，下面的数字来自同一份本地计算。</p>
  </div>
</template>

<style scoped>
.chart-wrap {
  width: 100%;
}

.chart {
  width: 100%;
  height: 100%;
}
</style>
