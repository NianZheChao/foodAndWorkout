/** 模型调用的错误分类。分类决定「重试 / 入队 / 直接告诉用户」三种不同处置（§6.8 / §10.1）。 */

export type LlmErrorKind =
  | 'not-configured'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'bad-request'
  | 'unsupported-param'
  | 'unsupported-image'
  | 'http'
  | 'empty-response'
  | 'bad-json'
  | 'schema'
  // 估算超预算、用户在告警里选了「先不发」：不是失败，是用户的选择（§6.9）
  | 'cancelled'

export interface LlmErrorOptions {
  status?: number
  retriable?: boolean
  detail?: string
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status?: number
  readonly retriable: boolean
  readonly detail?: string

  constructor(kind: LlmErrorKind, message: string, options: LlmErrorOptions = {}) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = options.status
    this.retriable = options.retriable ?? false
    this.detail = options.detail
  }
}

/** 把任意异常归一成 LlmError，未知异常按网络问题处理（最保守）。 */
export function toLlmError(cause: unknown): LlmError {
  if (cause instanceof LlmError) return cause
  return new LlmError('network', cause instanceof Error ? cause.message : String(cause), { retriable: true })
}
