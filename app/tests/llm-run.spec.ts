import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTask, type LlmTask } from '@/llm'
import { db } from '@/data/db'
import { getModelConfig, saveModelConfig } from '@/data/repositories/modelConfig'
import { listLlmLogs } from '@/data/repositories/llmLogs'
import { chatOk, fakeResponse, stubFetch } from './helpers/llm'
import type { ModelConfigRecord } from '@/domain/types'

const task: LlmTask<{ text: string }, { value: number }> = {
  id: 'test.task',
  version: 3,
  title: '测试任务',
  systemPrompt: '只输出 JSON。',
  buildPayload: (input) => ({ text: input.text }),
  schema: z.object({ value: z.coerce.number() }),
  maxOutputTokens: 64
}

function config(patch: Partial<ModelConfigRecord> = {}): ModelConfigRecord {
  return {
    id: 'current',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    timeoutMs: 1000,
    enabled: true,
    updatedAt: Date.now(),
    ...patch
  }
}

const noSleep = async (): Promise<void> => undefined

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('runTask 流水线', () => {
  it('没配模型时直接返回 not-configured，不发请求', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"value":1}')])
    const result = await runTask(task, { text: 'x' }, { config: config({ apiKey: '' }), deps: { fetchImpl } })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe('not-configured')
    expect(calls).toHaveLength(0)
  })

  it('200 但结构不合规时，只附错误摘要重试一次', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"value":"abc"}'), chatOk('{"value":7}')])
    const result = await runTask(
      task,
      { text: 'x' },
      { config: config(), deps: { fetchImpl }, sleep: noSleep, retryDelayMs: 0 }
    )

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.value.value).toBe(7)
    expect(calls).toHaveLength(2)
    const retry = calls[1].body.messages as { content: string }[]
    expect(retry).toHaveLength(3)
    expect(retry[2].content).toContain('"retry":true')
    expect(retry[2].content).toContain('validationError')
  })

  it('两次都不合规就返回 schema 失败，且不写任何业务数据', async () => {
    const { fetchImpl } = stubFetch([chatOk('{"value":"abc"}'), chatOk('{"value":"def"}')])
    const result = await runTask(
      task,
      { text: 'x' },
      { config: config(), deps: { fetchImpl }, sleep: noSleep, retryDelayMs: 0 }
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe('schema')
    expect(result.ok === false && result.validationError).toContain('value')
  })

  it('网络失败退避重试一次后成功', async () => {
    const { fetchImpl, calls } = stubFetch([new Error('socket hang up'), chatOk('{"value":3}')])
    const result = await runTask(
      task,
      { text: 'x' },
      { config: config(), deps: { fetchImpl }, sleep: noSleep, retryDelayMs: 0 }
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('接口不支持 response_format 时自动去掉该参数重试，并把结论写进配置备忘录', async () => {
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'gpt-test' })
    const { fetchImpl, calls } = stubFetch([
      fakeResponse({ error: { message: 'response_format is not supported' } }, 400),
      chatOk('{"value":9}')
    ])
    const result = await runTask(
      task,
      { text: 'x' },
      { config: await getModelConfig(), deps: { fetchImpl }, sleep: noSleep, retryDelayMs: 0 }
    )
    expect(result.ok).toBe(true)
    expect('response_format' in calls[0].body).toBe(true)
    expect('response_format' in calls[1].body).toBe(false)
    expect((await getModelConfig()).supportsJsonResponse).toBe(false)
  })

  it('JSON 模式返回空正文时同样降级重试（DeepSeek 的空正文就是这种）', async () => {
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' })
    const { fetchImpl, calls } = stubFetch([
      // 200 但正文为空：服务端认了请求，只是 JSON 模式没吐出内容
      fakeResponse({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
      chatOk('{"value":7}')
    ])
    const result = await runTask(
      task,
      { text: 'x' },
      { config: await getModelConfig(), deps: { fetchImpl }, sleep: noSleep, retryDelayMs: 0 }
    )

    expect(result.ok).toBe(true)
    expect('response_format' in calls[0].body).toBe(true)
    expect('response_format' in calls[1].body).toBe(false)
    // 结论写进备忘录，后续请求不再白撞一次
    expect((await getModelConfig()).supportsJsonResponse).toBe(false)
  })

  it('每次调用都留一条只含估算值与状态的日志', async () => {
    const { fetchImpl } = stubFetch([chatOk('{"value":1}')])
    await runTask(task, { text: 'x' }, { config: config(), deps: { fetchImpl } })
    const logs = await listLlmLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ taskId: 'test.task', taskVersion: 3, status: 'ok' })
    // 日志里只有估算值，没有 prompt / 响应正文
    expect(Object.keys(logs[0])).not.toContain('text')
  })
})
