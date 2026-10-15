/** 模型相关单测的公共替身：一个可编程的 fetch 与极简 Response。 */

import { vi } from 'vitest'

export function fakeResponse(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  } as unknown as Response
}

/** 一次 200 的典型 Chat Completions 响应。 */
export function chatOk(content: string, model = 'test-model'): Response {
  return fakeResponse({
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 6 }
  })
}

export interface RecordedCall {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * 按顺序返回预设响应；用尽后重复最后一个。
 * 同时把所有请求记下来，便于断言「第二次请求带上了 validationError」这类行为。
 */
export function stubFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let index = 0
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>
    })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
