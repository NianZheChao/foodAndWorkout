<script setup lang="ts">
/**
 * 数据页（T4.1 / FR-1204 ~ FR-1209）。
 *
 * 两件事：**导出**一个 JSON 包（FR-1204 / FR-1207）、**导入**别人（或自己以前的）包
 * （FR-1205）。导入是危险动作，所以流程刻意长一点：先选文件 → 校验 + 预演差异 →
 * 选冲突策略（默认「跳过」最安全）→ 显式点确认 → 看导入报告。
 *
 * 导出包里**没有模型 token 也没有调用日志**（FR-1305），这一点在界面上明说。
 */

import { computed, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { todayIso } from '@/app/date'
import { db } from '@/data/db'
import { buildExportPackage, exportFileName, serializeExport, type ExportPackage } from '@/io/exportPackage'
import {
  buildWorkspaceExport,
  bundleWorkspaceFiles,
  workspaceExportFileName,
  workspaceExportStats,
  type WorkspaceExportStats,
  type WorkspaceFile
} from '@/io/workspaceExport'
import {
  applyImport,
  parseExportPackage,
  previewImport,
  type ConflictStrategy,
  type ImportPreview,
  type ImportReport
} from '@/io/importPackage'

/** 统计口径与导出包一致，标签只给用户看。 */
const COUNT_LABELS: Record<string, string> = {
  days: '天记录',
  intake: '条饮食',
  workout: '条训练',
  foods: '条食物',
  reports: '份报告',
  calibrations: '条校准',
  snapshots: '个快照',
  pendingOps: '条待办',
  drafts: '份草稿',
  adviceLog: '条指导',
  targets: '目标',
  profile: '档案',
  settings: '设置'
}

const busy = ref(false)
const loaded = ref(false)
const errorMessage = ref('')
const counts = ref<Record<string, number>>({})
const exported = ref<{ counts: Record<string, number>; checksum: string; name: string }>()
const workspace = ref<{ files: WorkspaceFile[]; stats: WorkspaceExportStats; name: string }>()
const picked = ref<{ pkg: ExportPackage; preview: ImportPreview; fileName: string }>()
const strategy = ref<ConflictStrategy>('skip')
const pickedDates = ref<string[]>([])
const report = ref<ImportReport>()
const storageLabel = ref('')
const fileInput = ref<HTMLInputElement>()

async function loadCounts(): Promise<void> {
  const [days, intake, workout, foods, reports, calibrations, pendingOps, drafts, adviceLog, targets, profile, settings] =
    await Promise.all([
      db.days.count(),
      db.intake.count(),
      db.workout.count(),
      db.foods.count(),
      db.reports.count(),
      db.calibrations.count(),
      db.pendingOps.count(),
      db.drafts.count(),
      db.adviceLog.count(),
      db.targets.count(),
      db.profile.count(),
      db.settings.count()
    ])
  counts.value = { days, intake, workout, foods, reports, calibrations, pendingOps, drafts, adviceLog, targets, profile, settings }
}

onMounted(async () => {
  await loadCounts()
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.usage !== undefined) storageLabel.value = `${(estimate.usage / 1024 / 1024).toFixed(1)} MB`
  } catch {
    // 存储占用只是参考信息：浏览器不支持（或被拒绝）就留空，不影响导出与导入
  }
  loaded.value = true
})

const countRows = computed(() =>
  Object.keys(COUNT_LABELS)
    .filter((key) => (counts.value[key] ?? 0) > 0)
    .map((key) => ({ key, label: COUNT_LABELS[key], value: counts.value[key] ?? 0 }))
)

async function exportNow(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  try {
    const pkg = await buildExportPackage()
    const name = exportFileName(todayIso())
    exported.value = { counts: pkg.manifest.counts, checksum: pkg.checksum, name }
    // jsdom / 老浏览器里没有 createObjectURL：那就只展示"已生成"，不触发下载
    if (typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([serializeExport(pkg)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
    showToast({ message: '导出完成', position: 'bottom' })
  } catch (cause) {
    errorMessage.value = `导出失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}

async function onPickFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = true
  errorMessage.value = ''
  picked.value = undefined
  report.value = undefined
  try {
    const parsed = await parseExportPackage(await file.text())
    if (!parsed.ok) {
      errorMessage.value = parsed.error
      return
    }
    const preview = await previewImport(parsed.pkg)
    picked.value = { pkg: parsed.pkg, preview, fileName: file.name }
    // 默认最安全：跳过冲突日；「覆盖」要用户自己去勾日期
    strategy.value = 'skip'
    pickedDates.value = []
  } catch (cause) {
    errorMessage.value = `读取失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function confirmImport(): Promise<void> {
  if (!picked.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    report.value = await applyImport(picked.value.pkg, {
      strategy: strategy.value,
      overwriteDates: pickedDates.value
    })
    await loadCounts()
    showToast({ message: '导入完成', position: 'bottom' })
  } catch (cause) {
    errorMessage.value = `导入失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}

function toggleDate(date: string): void {
  pickedDates.value = pickedDates.value.includes(date)
    ? pickedDates.value.filter((item) => item !== date)
    : [...pickedDates.value, date].sort()
}

function addedLabel(key: string): string {
  return `${COUNT_LABELS[key] ?? key} ${report.value?.added[key] ?? 0}`
}

/**
 * 工作区文本导出（T4.2 / §7.2）：一个 Markdown 文本包，里面的文件与仓库脚本共用同一套格式。
 * 和 JSON 包的区别：JSON 是给**应用**读回来用的，这一份是给**人和脚本**看的（FR-1206）。
 */
async function exportWorkspace(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  try {
    const files = await buildWorkspaceExport()
    const name = workspaceExportFileName(todayIso())
    workspace.value = { files, stats: workspaceExportStats(files), name }
    if (typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([bundleWorkspaceFiles(files)], { type: 'text/markdown' }))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
    showToast({ message: '已生成工作区文本', position: 'bottom' })
  } catch (cause) {
    errorMessage.value = `导出失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader title="数据" subtitle="导出 / 导入都在本机完成，不经任何服务器" back />

    <div class="card">
      <h2 class="card-title">导出</h2>
      <p class="muted">
        一个 JSON 文件装下记录、食物库、报告、目标、档案、设置、草稿与指导历史。
        <strong>模型 token 与调用日志不导出</strong>（换设备后需要重新填一次）。
      </p>
      <ul v-if="countRows.length" class="hint-list">
        <li v-for="row in countRows" :key="row.key">{{ row.label }}：{{ row.value }}</li>
      </ul>
      <p v-else class="muted">本机暂时没有数据。</p>
      <p v-if="storageLabel" class="muted">已用存储：{{ storageLabel }}（仅供参考，浏览器可能给的是估算值）</p>
      <div class="actions">
        <van-button type="primary" block :loading="busy" @click="exportNow">导出 JSON</van-button>
      </div>
      <template v-if="exported">
        <div class="kv">
          <span class="kv-key">文件名</span>
          <span class="kv-value">{{ exported.name }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">校验和（sha256 前 12 位）</span>
          <span class="kv-value">{{ exported.checksum.slice(0, 12) }}…</span>
        </div>
      </template>
    </div>

    <div class="card">
      <h2 class="card-title">导出为工作区格式</h2>
      <p class="muted">
        生成一个 Markdown 文本包，里面是原工作区那一套文件：<code>records/YYYY-MM-DD.md</code>
        （含由本地算好的 AUTO 汇总区块）、<code>data/foods.csv</code>、<code>profile.md</code>、
        <code>targets.md</code>。格式与原脚本一致，放进工作区就能直接跑
        <code>python scripts/nutrition.py check --all</code>，不被这个应用锁住。
      </p>
      <div class="actions">
        <van-button plain block :loading="busy" @click="exportWorkspace">导出工作区文本</van-button>
      </div>
      <template v-if="workspace">
        <div class="kv">
          <span class="kv-key">文件名</span>
          <span class="kv-value">{{ workspace.name }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">内容</span>
          <span class="kv-value">
            {{ workspace.stats.records }} 天记录 · {{ workspace.stats.foods }} 条食物 · 共 {{ workspace.stats.lines }} 行
          </span>
        </div>
        <ul class="hint-list">
          <li v-for="file in workspace.files" :key="file.path">{{ file.path }}</li>
        </ul>
      </template>
    </div>

    <div class="card">
      <h2 class="card-title">导入</h2>
      <p class="muted">
        选一个之前导出的 JSON。导入前会先校验（是不是本应用的文件 / 版本 / 校验和），
        再给你看会新增什么、与哪些日期冲突；确认之后才写库。
      </p>
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        accept="application/json,.json"
        @change="onPickFile"
      />

      <template v-if="picked">
        <h2 class="card-title">将要导入</h2>
        <p class="muted">文件：{{ picked.fileName }}</p>
        <ul class="hint-list">
          <li v-for="(value, key) in picked.preview.counts" :key="key">
            {{ COUNT_LABELS[key] ?? key }}：{{ value }}
          </li>
        </ul>
        <div class="kv">
          <span class="kv-key">新增日期</span>
          <span class="kv-value">{{ picked.preview.newDates.length }} 天</span>
        </div>
        <div class="kv">
          <span class="kv-key">冲突日期（本机已有）</span>
          <span class="kv-value">{{ picked.preview.conflictDates.length }} 天</span>
        </div>
        <div class="kv">
          <span class="kv-key">食物</span>
          <span class="kv-value">
            新增 {{ picked.preview.newFoods }} 条 · 与本地重名 {{ picked.preview.duplicateFoods }} 条（保留本地）
          </span>
        </div>
        <p v-if="picked.preview.singletons.targets || picked.preview.singletons.profile || picked.preview.singletons.settings" class="muted">
          目标 / 档案 / 设置已经存在：按字段合并，本机已有的值不会被冲掉。
        </p>

        <h2 class="card-title">冲突怎么处理</h2>
        <div class="strategy-row">
          <label class="strategy-item">
            <input v-model="strategy" type="radio" value="skip" />
            跳过（保留本机）
          </label>
          <label class="strategy-item">
            <input v-model="strategy" type="radio" value="merge" />
            合并（按 id 去重）
          </label>
          <label class="strategy-item">
            <input v-model="strategy" type="radio" value="overwrite" />
            覆盖（危险）
          </label>
        </div>

        <template v-if="strategy === 'overwrite' && picked.preview.conflictDates.length">
          <p class="muted warn-text">只勾选的日期会被覆盖；没勾的按「跳过」处理。</p>
          <div class="date-grid">
            <label v-for="date in picked.preview.conflictDates" :key="date" class="date-item">
              <input
                type="checkbox"
                :checked="pickedDates.includes(date)"
                @change="toggleDate(date)"
              />
              {{ date }}
            </label>
          </div>
        </template>

        <div class="actions">
          <van-button
            :type="strategy === 'overwrite' ? 'danger' : 'primary'"
            block
            :loading="busy"
            @click="confirmImport"
          >
            确认导入（{{ strategy === 'skip' ? '跳过冲突日' : strategy === 'merge' ? '合并' : `覆盖 ${pickedDates.length} 天` }}）
          </van-button>
        </div>
      </template>
    </div>

    <div v-if="report" class="card">
      <h2 class="card-title">导入报告</h2>
      <ul class="hint-list">
        <li v-for="key in Object.keys(report.added)" :key="key">{{ addedLabel(key) }}</li>
      </ul>
      <div class="kv">
        <span class="kv-key">跳过</span>
        <span class="kv-value">
          天 {{ report.skipped.days }} · 饮食 {{ report.skipped.intake }} · 训练 {{ report.skipped.workout }}
        </span>
      </div>
      <div class="kv">
        <span class="kv-key">重名的食物</span>
        <span class="kv-value">{{ report.duplicateFoods }} 条（保留本地版本）</span>
      </div>
      <div class="kv">
        <span class="kv-key">重算汇总</span>
        <span class="kv-value">{{ report.recomputedDays }} 天</span>
      </div>
      <ul v-if="report.singletonFields.length" class="hint-list">
        <li v-for="item in report.singletonFields" :key="item">从文件补上：{{ item }}</li>
      </ul>
      <ul v-if="report.overriddenFields.length" class="hint-list">
        <li v-for="item in report.overriddenFields" :key="item">两边都有、按规则取其一：{{ item }}</li>
      </ul>
    </div>

    <p v-if="errorMessage" class="muted warn-text">{{ errorMessage }}</p>
  </section>
</template>

<style scoped>
.file-input {
  width: 100%;
  margin: 8px 0;
  font-size: 13px;
}

.strategy-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.strategy-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
}

.date-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}

.date-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}
</style>
