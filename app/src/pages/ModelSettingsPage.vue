<script setup lang="ts">
/**
 * 模型设置（M13 / FR-1300）。
 *
 * 这个应用强依赖模型，但**不替用户配**：地址、token、模型名都要用户自己填。
 * token 只存本机 IndexedDB，不进导出包、不写日志、不在提示里回显（FR-1305 / NFR-11）。
 */

import { computed, onMounted, ref } from 'vue'
import { showDialog, showToast } from 'vant'
import { clearModelCredentials, getModelConfig, saveModelConfig } from '@/data/repositories/modelConfig'
import { clearLlmLogs, listLlmLogs, summarizeLlmUsage, type LlmUsageSummary } from '@/data/repositories/llmLogs'
import { normalizeBaseUrl, probeModel } from '@/llm'
import type { LlmLog, ModelConfigRecord } from '@/domain/types'

const config = ref<ModelConfigRecord>()
const usage = ref<LlmUsageSummary>()
const logs = ref<LlmLog[]>([])
const testing = ref(false)
const probeMessage = ref('')

const form = ref({ baseUrl: '', apiKey: '', model: '', timeoutSeconds: '60', enabled: true })

function syncForm(row: ModelConfigRecord): void {
  form.value = {
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: row.model,
    timeoutSeconds: String(Math.round(row.timeoutMs / 1000)),
    enabled: row.enabled
  }
}

async function load(): Promise<void> {
  const row = await getModelConfig()
  config.value = row
  if (!row.baseUrl && !form.value.baseUrl) syncForm(row)
  usage.value = await summarizeLlmUsage()
  logs.value = await listLlmLogs(10)
}

onMounted(load)

/** 用户填整条 `.../chat/completions` 也认，这里把最终请求地址显示出来，避免猜。 */
const requestUrl = computed(() =>
  form.value.baseUrl.trim() ? `${normalizeBaseUrl(form.value.baseUrl)}/chat/completions` : '—'
)

const timeoutSeconds = computed(() => {
  const value = Number(form.value.timeoutSeconds)
  return Number.isFinite(value) && value >= 5 ? Math.min(Math.round(value), 300) : 60
})

async function persist(): Promise<ModelConfigRecord> {
  const row = await saveModelConfig({
    baseUrl: normalizeBaseUrl(form.value.baseUrl),
    apiKey: form.value.apiKey.trim(),
    model: form.value.model.trim(),
    timeoutMs: timeoutSeconds.value * 1000,
    enabled: form.value.enabled
  })
  config.value = row
  return row
}

async function save(): Promise<void> {
  await persist()
  syncForm(config.value as ModelConfigRecord)
  showToast({ message: '已保存到本机', position: 'bottom' })
}

async function test(): Promise<void> {
  testing.value = true
  try {
    const row = await persist()
    const result = await probeModel(row)
    probeMessage.value = result.message
    showToast({ message: result.ok ? '连接正常' : '连接失败', position: 'bottom' })
  } finally {
    testing.value = false
    await load()
  }
}

async function confirmClear(): Promise<void> {
  await showDialog({
    title: '清空模型配置',
    message: '会删掉本机保存的地址与 token。已解析出来的食物数据不受影响。'
  })
  config.value = await clearModelCredentials()
  syncForm(config.value)
  probeMessage.value = ''
  showToast({ message: '已清空', position: 'bottom' })
}

async function clearUsage(): Promise<void> {
  await clearLlmLogs()
  usage.value = await summarizeLlmUsage()
  logs.value = []
  showToast({ message: '已清空用量记录', position: 'bottom' })
}

function formatTime(value?: number): string {
  if (!value) return '—'
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <section class="page">
    <h1 class="page-title">模型设置</h1>
    <p class="page-subtitle">只支持 OpenAI 兼容接口；记录链路不依赖它，没配也能照常记。</p>

    <div class="card">
      <h2 class="card-title">接口</h2>
      <van-field v-model="form.baseUrl" label="Base URL" placeholder="https://api.example.com/v1" />
      <van-field v-model="form.apiKey" label="Token" type="password" placeholder="sk-..." />
      <van-field v-model="form.model" label="模型名" placeholder="例如 gpt-4o-mini" />
      <van-field v-model="form.timeoutSeconds" label="超时(秒)" type="number" placeholder="60" />
      <van-cell center title="启用">
        <template #right-icon>
          <van-switch v-model="form.enabled" />
        </template>
      </van-cell>

      <div class="kv">
        <span class="kv-key">实际请求地址</span>
        <span class="kv-value">{{ requestUrl }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">JSON 模式</span>
        <span class="kv-value">
          {{ config?.supportsJsonResponse === undefined ? '未探测' : config.supportsJsonResponse ? '支持' : '不支持（已降级）' }}
        </span>
      </div>

      <div class="actions">
        <van-button type="primary" block @click="save">保存</van-button>
        <van-button plain type="primary" block :loading="testing" @click="test">测试连通性</van-button>
        <van-button plain block @click="confirmClear">清空配置</van-button>
      </div>
      <p v-if="probeMessage" class="muted">{{ probeMessage }}</p>
      <p class="muted">上次测试：{{ formatTime(config?.lastTestAt) }}</p>
    </div>

    <div class="card">
      <h2 class="card-title">用量（估算）</h2>
      <div class="kv">
        <span class="kv-key">调用次数</span>
        <span class="kv-value">{{ usage?.calls ?? 0 }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">失败次数</span>
        <span class="kv-value">{{ usage?.errors ?? 0 }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">输入 tokens（估）</span>
        <span class="kv-value">{{ usage?.promptTokensEst ?? 0 }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">输出 tokens（估）</span>
        <span class="kv-value">{{ usage?.completionTokensEst ?? 0 }}</span>
      </div>
      <p class="muted">按「中日韩字符 / 1.6 + 其余 / 4」粗估，只用来看量级，不作为计费依据。</p>
      <div v-if="logs.length" class="log-list">
        <div v-for="row in logs" :key="row.id" class="kv">
          <span class="kv-key">{{ formatTime(row.createdAt) }} · {{ row.taskId }}</span>
          <span class="kv-value">
            {{ row.status === 'ok' ? `${row.promptTokensEst}+${row.completionTokensEst}` : row.errorKind }}
          </span>
        </div>
      </div>
      <van-button size="small" plain block @click="clearUsage">清空调用记录</van-button>
    </div>

    <div class="card">
      <h2 class="card-title">安全</h2>
      <ul class="hint-list">
        <li>token 只保存在本机 IndexedDB，不进导出包、不写日志、不在错误提示里回显。</li>
        <li>所有请求都由浏览器直接发给你填的地址，本应用没有后端，也不经过任何第三方。</li>
        <li>营养换算、汇总、达标率等确定性计算全部在本地完成，不会把数字交给模型算。</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 8px;
}

.hint-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.7;
}

.log-list {
  margin: 8px 0;
}
</style>
