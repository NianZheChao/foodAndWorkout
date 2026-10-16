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
import { showDialog, showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { formatDateTime, todayIso } from '@/app/date'
import { db } from '@/data/db'
import { SNAPSHOT_KEEP } from '@/data/repositories/snapshots'
import {
  captureDay,
  listSnapshotSummaries,
  restoreDaySnapshot,
  type RestoreReport,
  type SnapshotSummary
} from '@/application/snapshot'
import { useDayStore } from '@/store/day'
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
const snapshotDate = ref(todayIso())
const snapshots = ref<SnapshotSummary[]>([])
const restoreReport = ref<RestoreReport>()

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
  snapshots.value = await listSnapshotSummaries(20)
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

/** 手动拍一张快照；内容与上一条完全一致时不会重复写（`deduped`）。 */
async function takeSnapshot(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  try {
    const summary = await captureDay(snapshotDate.value, '手动快照')
    await loadCounts()
    showToast({ message: summary.deduped ? '与上一条快照内容一致，未重复保存' : '已拍一张快照', position: 'bottom' })
  } catch (cause) {
    errorMessage.value = `拍快照失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}

/**
 * 回滚到某一条快照。回滚是**整天替换**，所以要二次确认；动手前 `restoreDaySnapshot` 还会
 * 自动给当前状态再拍一张，误点了也能滚回来。回滚的这一天正好是用户当前在看的那天时，
 * 顺手让当日 store 重新读一次，免得回到今日页看到的是旧数据。
 */
async function rollback(item: SnapshotSummary): Promise<void> {
  if (item.broken) {
    errorMessage.value = '这条快照读不出来（可能被改坏或来自更新的版本），不能回滚。'
    return
  }
  try {
    await showDialog({
      title: `回滚到 ${item.date}`,
      message:
        `这一天的记录会被替换成快照里的样子（饮食 ${item.counts.intake} 条 / 训练 ${item.counts.workout} 条）。` +
        '回滚前会自动再拍一张当前状态，所以还能滚回来。'
    })
  } catch {
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await restoreDaySnapshot(item.id)
    restoreReport.value = result
    await loadCounts()
    if (useDayStore().date === result.date) await useDayStore().refresh()
    showToast({ message: '已回滚', position: 'bottom' })
  } catch (cause) {
    errorMessage.value = `回滚失败：${cause instanceof Error ? cause.message : String(cause)}`
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
      <h2 class="card-title">快照与回滚</h2>
      <p class="muted">
        可能毁数据的动作（导入覆盖 / 合并、删掉某条记录）之前，会自动给那一天拍一张快照。
        回滚是 <strong>整天替换</strong>：头部、饮食、训练一起还原成快照里的样子，汇总按本地口径重算；
        动手前还会再自动拍一张，所以点错了也能滚回来。
      </p>
      <div class="snapshot-row">
        <input v-model="snapshotDate" class="snapshot-date" type="date" />
        <van-button size="small" plain :loading="busy" @click="takeSnapshot">拍一张快照</van-button>
      </div>
      <p v-if="!snapshots.length" class="muted">还没有快照。</p>
      <ul v-else class="snapshot-list">
        <li v-for="item in snapshots" :key="item.id" class="snapshot-item">
          <div class="snapshot-head">
            <span>{{ formatDateTime(item.createdAt) }}</span>
            <span class="snapshot-day">{{ item.date }}</span>
          </div>
          <p class="muted">{{ item.reason }}</p>
          <div class="kv">
            <span class="kv-key">内容</span>
            <span class="kv-value">饮食 {{ item.counts.intake }} 条 · 训练 {{ item.counts.workout }} 条</span>
          </div>
          <p v-if="item.broken" class="muted warn-text">这条快照读不出来（被改坏或来自更新的版本），不能回滚。</p>
          <div class="actions">
            <van-button size="small" block :disabled="item.broken" :loading="busy" @click="rollback(item)">
              回滚到 {{ item.date }}
            </van-button>
          </div>
        </li>
      </ul>
      <template v-if="restoreReport">
        <h2 class="card-title">回滚结果（{{ restoreReport.date }}）</h2>
        <div class="kv">
          <span class="kv-key">回滚后</span>
          <span class="kv-value">
            头部{{ restoreReport.restored.day ? '有' : '无' }} · 饮食 {{ restoreReport.restored.intake }} 条 · 训练 {{ restoreReport.restored.workout }} 条
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">被替换掉的原状态</span>
          <span class="kv-value">
            头部{{ restoreReport.replaced.day ? '有' : '无' }} · 饮食 {{ restoreReport.replaced.intake }} 条 · 训练 {{ restoreReport.replaced.workout }} 条
          </span>
        </div>
        <ul class="hint-list">
          <li>汇总：{{ restoreReport.summaryRecomputed ? '已重算' : '那天没有记录，无需重算' }}</li>
          <li>回滚前的自动备份：{{ restoreReport.backupId }}（原因写「回滚前自动快照」，也在上面的列表里）</li>
        </ul>
      </template>
      <p class="muted">只保留最近 {{ SNAPSHOT_KEEP }} 条快照，更早的会被自动清掉。</p>
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

.snapshot-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.snapshot-date {
  flex: 1 1 150px;
  min-height: 34px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
}

.snapshot-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.snapshot-item {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.snapshot-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.snapshot-day {
  color: var(--text-muted);
}
