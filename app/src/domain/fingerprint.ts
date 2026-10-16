/**
 * 缓存指纹：本地数据没变就复用上一次的模型结果（§6.4.2 频率与缓存 / §6.9 结果缓存）。
 *
 * 每日指导（A 级）与生成式推荐（B 级）都要判「数据变了没」，所以实现只留这一份：
 * djb2 各写一遍，迟早会出现「一边改了键序规则、另一边没改」。
 */

/** 稳定序列化：键排序后输出，保证同样的数据得到同样的指纹（键序不该影响缓存判断）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/**
 * djb2：不是密码学哈希，只要「数据变了指纹就变、没变就一样」够用。
 */
export function fingerprintOf(value: unknown): string {
  const text = stableStringify(value)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}