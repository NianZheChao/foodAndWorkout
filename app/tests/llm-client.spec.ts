import { describe, expect, it } from 'vitest'
import { chatCompletion, chatCompletionsUrl, normalizeBaseUrl } from '@/llm/client'
import { LlmError } from '@/llm/errors'
import { estimateTokens, findJsonSpan, parseJsonFromModel, stripCodeFence } from '@/llm/text'
import { chatOk, fakeResponse, stubFetch } from './helpers/llm'

const base = {
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxOutputTokens: 100
}

describe('baseUrl 归一化', () => {
  it('既接受 base，也接受整条 chat/completions 或带尾斜杠的写法', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('  https://api.example.com/v1/chat/completions/  ')).toBe('https://api.example.com/v1')
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
  })
})

describe('模型文本处理', () => {
  it('剥掉 ```json 包裹', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}')
  })

  it('从夹杂说明文字的回复里抽出 JSON', () => {
    expect(parseJsonFromModel('好的，结果如下：\n{"kind":"intake"}\n以上。')).toEqual({ kind: 'intake' })
    expect(parseJsonFromModel('```json\n{"items":[{"a":"}"}]}\n```')).toEqual({ items: [{ a: '}' }] })
    expect(findJsonSpan('没有 JSON')).toBeUndefined()
  })

  it('拿不到 JSON 时抛 bad-json，空内容抛 empty-response', () => {
    expect(() => parseJsonFromModel('   ')).toThrow(LlmError)
    try {
      parseJsonFromModel('完全没有结构')
    } catch (error) {
      expect((error as LlmError).kind).toBe('bad-json')
    }
  })

  it('中文按 chars/1.6、ASCII 按 chars/4 粗估', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('西红柿鸡蛋拌面')).toBe(5)
  })
})

describe('chatCompletion', () => {
  it('按 OpenAI 兼容协议发请求，并在开启时带上 response_format', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"ok":true}')])
    const result = await chatCompletion({ ...base, jsonResponse: true, timeoutMs: 1000 }, { fetchImpl })

    expect(calls[0].url).toBe('https://example.com/v1/chat/completions')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    expect(calls[0].body.model).toBe('gpt-test')
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' })
    expect(calls[0].body.temperature).toBe(0.2)
    expect(calls[0].body.max_tokens).toBe(100)
    expect(result.text).toBe('{"ok":true}')
    expect(result.model).toBe('test-model')
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 6 })
    expect(result.promptTokensEst).toBeGreaterThan(0)
  })

  it('未开启 jsonResponse 时不带 response_format', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('hi')])
    await chatCompletion({ ...base, jsonResponse: false, timeoutMs: 1000 }, { fetchImpl })
    expect('response_format' in calls[0].body).toBe(false)
  })

  it('把 HTTP 错误分成 auth / rate-limit / server / unsupported-*', async () => {
    const cases: [number, string, string, boolean][] = [
      [401, '{"error":{"message":"invalid key"}}', 'auth', false],
      [429, 'slow down', 'rate-limit', true],
      [503, 'upstream down', 'server', true],
      [404, 'not found', 'bad-request', false]
    ]
    for (const [status, body, kind, retriable] of cases) {
      const { fetchImpl } = stubFetch([fakeResponse(body, status)])
      try {
        await chatCompletion({ ...base, timeoutMs: 1000 }, { fetchImpl })
        throw new Error('应该抛错')
      } catch (error) {
        expect((error as LlmError).kind, `${status}`).toBe(kind)
        expect((error as LlmError).retriable, `${status}`).toBe(retriable)
      }
    }

    const unsupported = stubFetch([fakeResponse('response_format is not supported', 400)])
    await expect(
      chatCompletion({ ...base, jsonResponse: true, timeoutMs: 1000 }, { fetchImpl: unsupported.fetchImpl })
    ).rejects.toMatchObject({ kind: 'unsupported-param' })

    const vision = stubFetch([
      fakeResponse({ error: { message: 'this model does not support image input' } }, 400)
    ])
    await expect(
      chatCompletion(
        {
          ...base,
          timeoutMs: 1000,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '看图' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }
              ]
            }
          ]
        },
        { fetchImpl: vision.fetchImpl }
      )
    ).rejects.toMatchObject({ kind: 'unsupported-image' })
  })

  it('超时按 timeout 归类为可重试', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    await expect(chatCompletion({ ...base, timeoutMs: 5 }, { fetchImpl })).rejects.toMatchObject({
      kind: 'timeout',
      retriable: true
    })
  })

  it('没有配置就不发请求', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('x')])
    await expect(chatCompletion({ ...base, apiKey: '' }, { fetchImpl })).rejects.toMatchObject({
      kind: 'not-configured'
    })
    expect(calls).toHaveLength(0)
  })

  it('空内容与 200 里的 error 都能识别出来', async () => {
    const empty = stubFetch([fakeResponse({ choices: [{ message: { content: '  ' } }] })])
    await expect(chatCompletion({ ...base, timeoutMs: 1000 }, { fetchImpl: empty.fetchImpl })).rejects.toMatchObject({
      kind: 'empty-response'
    })

    const apiError = stubFetch([fakeResponse({ error: { message: 'quota exceeded' } })])
    await expect(
      chatCompletion({ ...base, timeoutMs: 1000 }, { fetchImpl: apiError.fetchImpl })
    ).rejects.toMatchObject({ kind: 'http' })
  })

  it('同一时刻最多一个在途请求（串行）', async () => {
    let inflight = 0
    let peak = 0
    const fetchImpl = (async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inflight -= 1
      return chatOk('{"a":1}')
    }) as unknown as typeof fetch

    await Promise.all([
      chatCompletion({ ...base, timeoutMs: 1000 }, { fetchImpl }),
      chatCompletion({ ...base, timeoutMs: 1000 }, { fetchImpl }),
      chatCompletion({ ...base, timeoutMs: 1000 }, { fetchImpl })
    ])
    expect(peak).toBe(1)
  })
})
