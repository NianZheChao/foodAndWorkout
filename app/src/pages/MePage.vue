<script setup lang="ts">
/**
 * 我的（`app/src/app/nav.ts` 里 `me` 域的根页）：**关于「我」这个人的东西**都从这一支进 ——
 * 档案、目标、我的数据（导出 / 导入 / 快照）、关于与免责声明。
 *
 * 为什么单开一个域（2026-10-16 重构）：这些页面以前散在「今日页 → 更多」和「设置」里 ——
 * 设置页于是同时装着「应用怎么跑」（模型 / 提醒 / 外观）和「我是谁」（档案 / 数据 / 关于），
 * 两头都不好找。现在设置只管应用行为，这一页负责「我的东西」，各自的同级入口由页头导航条给。
 *
 * 这一页自己不做任何计算，只把仓储里的现状摆出来（数字都在 domain 层算）。
 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { fmtNumber } from '@/domain/format'
import { db, SCHEMA_VERSION } from '@/data/db'
import { META_KEYS, getMeta } from '@/data/meta'
import { countFoods } from '@/data/repositories/foods'
import { countOpenOps } from '@/data/repositories/pendingOps'
import { getProfile } from '@/data/repositories/profile'
import { getTargets } from '@/data/repositories/targets'
import type { ProfileRecord, TargetsRecord } from '@/domain/types'

const router = useRouter()

const profile = ref<ProfileRecord>()
const targets = ref<TargetsRecord>()
const foodCount = ref(0)
const queueCount = ref(0)
const seedVersion = ref('-')
const loaded = ref(false)

onMounted(async () => {
  const [record, target] = await Promise.all([getProfile(), getTargets()])
  profile.value = record
  targets.value = target
  foodCount.value = await countFoods()
  queueCount.value = await countOpenOps()
  seedVersion.value = (await getMeta<string>(META_KEYS.seedVersion)) ?? '-'
  loaded.value = true
})

/** 档案里的基础项（有才显示，没填的不摆一排「-」）。 */
const basics = computed(() => {
  const item = profile.value
  if (!item) return []
  return [
    { key: '性别', value: item.sex === 'male' ? '男' : '女' },
    { key: '年龄', value: item.age === undefined ? '' : `${item.age} 岁` },
    { key: '身高', value: item.heightCm === undefined ? '' : `${fmtNumber(item.heightCm)} cm` },
    { key: '体重', value: item.weightKg === undefined ? '' : `${fmtNumber(item.weightKg)} kg` },
    { key: '阶段目标', value: item.goal ?? '' },
    { key: '训练水平', value: item.trainingLevel ?? '' }
  ].filter((row) => row.value !== '')
})

/** 当前目标值（没有就空着，让用户去目标页做首次校准）。 */
const targetRows = computed(() => {
  const item = targets.value
  if (!item) return []
  return [
    { key: '热量', value: `${fmtNumber(item.kcalTarget)} kcal` },
    { key: '蛋白', value: `${fmtNumber(item.proteinTargetG)} g` },
    { key: '目标体重', value: `${fmtNumber(item.targetWeightKg)} kg` },
    { key: '每周训练', value: `${fmtNumber(item.weeklyTrainingDays)} 天` },
    { key: '上次校准', value: item.lastCalibrated ?? '还没有校准过' }
  ]
})
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader title="我的" subtitle="档案、目标、我的数据与关于都收在这一支" />

    <div class="group">
      <h2 class="group-title">档案与目标</h2>

      <div v-if="!profile" class="card">
        <h3 class="card-title">还没有档案</h3>
        <p class="muted">
          身高 / 年龄 / 阶段目标 / 训练水平是首次估算热量目标的输入，B 级推荐还要用到忌口、过敏、
          器材与每餐时间这些安全边界（FR-1003）。
        </p>
        <div class="actions">
          <van-button type="primary" block @click="router.push('/profile')">去填档案</van-button>
        </div>
      </div>

      <template v-else>
        <div class="card">
          <h3 class="card-title">档案</h3>
          <div v-for="row in basics" :key="row.key" class="kv">
            <span class="kv-key">{{ row.key }}</span>
            <span class="kv-value">{{ row.value }}</span>
          </div>
          <p class="muted">长期事实，只在真正变化时改；完整编辑（含约束与记录口径）在「档案」页。</p>
        </div>

        <div v-if="targets" class="card">
          <h3 class="card-title">当前目标</h3>
          <div v-for="row in targetRows" :key="row.key" class="kv">
            <span class="kv-key">{{ row.key }}</span>
            <span class="kv-value">{{ row.value }}</span>
          </div>
        </div>

        <div v-else class="card">
          <h3 class="card-title">还没有目标值</h3>
          <p class="muted">热量与蛋白的占比、达标率都要先有目标值；做一次校准就有了。</p>
          <div class="actions">
            <van-button plain type="primary" block @click="router.push('/targets')">去目标与校准</van-button>
          </div>
        </div>
      </template>
    </div>

    <div class="group">
      <h2 class="group-title">本机数据</h2>
      <div class="card">
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
        <p class="muted">
          记录只存在这台设备的 IndexedDB 里，没有后端也不做同步；换设备靠导出 / 导入（在「数据」页）。
        </p>
      </div>
    </div>
  </section>
</template>