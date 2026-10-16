/**
 * 应用版本（导出清单的 `manifest.appVersion` 要用）。
 *
 * 单独抽一个常量而不是直接 import `package.json`：`package.json` 里还有依赖版本等一堆
 * 与运行时无关的内容，打进产物没必要。这个常量与 `app/package.json` 的 `version` 由
 * `tests/export-package.spec.ts` 钉在一起，改了一处不改另一处会当场失败。
 */
export const APP_VERSION = '0.1.0'
