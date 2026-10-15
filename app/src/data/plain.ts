/**
 * 写入 IndexedDB 前的「拍平」。
 *
 * 为什么必须有：界面上的对象经常是 Vue 的响应式代理（`ref([])` 的 `.value`、`computed()` 的返回值、
 * `reactive()` 包裹的对象），而 IndexedDB 的 structuredClone **克隆不了 Proxy** ——
 * 直接 `put` 会抛 `DataCloneError: could not be cloned`。
 * 2026-10-15 记录训练时正是这样炸的：`muscles.value`（一个被代理的数组）从页面一路传到 `db.workout.put`。
 *
 * 用 JSON 往返而不是 `structuredClone`：后者同样克隆不了 Proxy；而按仓库契约，我们要落库的对象
 * 都是纯 JSON 可表达的（没有 Date / Map / Set / 函数）。
 *
 * 副作用（已知且可接受）：`undefined` 的字段会被丢掉 —— 领域类型里可选字段本来就允许缺省，
 * 缺省语义与 `undefined` 一致；`NaN` / `Infinity` 会变成 `null`，写入前各页面都已经做过数值校验。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
