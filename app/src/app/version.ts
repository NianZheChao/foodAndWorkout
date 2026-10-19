/**
 * 应用版本（导出清单的 `manifest.appVersion`、诊断信息与设置页页脚都用）。
 *
 * 单独抽一个常量而不是直接 import `package.json`：`package.json` 里还有依赖版本等一堆
 * 与运行时无关的内容，打进产物没必要。这个常量与 `app/package.json` 的 `version` 由
 * `tests/export-package.spec.ts` 钉在一起，改了一处不改另一处会当场失败。
 *
 * 版本号按日期编制：`0.1.MMDD`（如 2026-10-19 → `0.1.1019`）。
 * 发版时与 `app/package.json` 的 `version` 一起改；更新时间写发版时刻（Asia/Shanghai）。
 */
export const APP_VERSION = '0.1.1019'

/** 设置页底部展示的更新时间；每次发版与 `APP_VERSION` 同步更新。 */
export const APP_UPDATED_AT = '2026-10-19 20:43'
