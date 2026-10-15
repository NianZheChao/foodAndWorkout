/** 模型文本的清洗与 token 估算（§6.8 / §6.9）。 */

import { LlmError } from './errors'

/** 去掉 ```json 包裹；没有包裹时原样返回。 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

/** 在混合文本里找出第一个完整的 JSON 对象 / 数组（按括号配平，跳过字符串内的括号）。 */
export function findJsonSpan(text: string): string | undefined {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** 解析模型返回的 JSON：先整体解析，失败再抽取第一个配平片段。 */
export function parseJsonFromModel(text: string): unknown {
  const cleaned = stripCodeFence(text)
  if (!cleaned) throw new LlmError('empty-response', '模型返回了空内容')
  try {
    return JSON.parse(cleaned)
  } catch {
    // 多半是前后带了说明文字，继续尝试抽取
  }
  const span = findJsonSpan(cleaned)
  if (!span) throw new LlmError('bad-json', '模型返回的内容里找不到 JSON', { detail: cleaned.slice(0, 200) })
  try {
    return JSON.parse(span)
  } catch (cause) {
    throw new LlmError('bad-json', '模型返回的 JSON 无法解析', {
      detail: cause instanceof Error ? cause.message : String(cause)
    })
  }
}

const WIDE_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/

/** 粗略估算 token：中日韩与全角字符按 chars/1.6，其余按 chars/4（§6.9）。只为预算与展示。 */
export function estimateTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if (WIDE_CHAR.test(char)) wide += 1
    else narrow += 1
  }
  return Math.ceil(wide / 1.6 + narrow / 4)
}
