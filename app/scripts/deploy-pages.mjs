/**
 * 把构建产物发布到 GitHub Pages 用的部署仓库（默认 `NianZheChao/foodAndWorkout_deploy`）。
 *
 * 为什么是**另一个仓库**：这个仓库只放应用本体与验收基准（见 AGENTS.md），
 * 构建产物（`app/dist/`）本来就在 `.gitignore` 里，不适合混进本体仓库的历史。
 * 部署仓库只装产物：一次发布一个提交，想回滚就回滚到上一个提交。
 *
 * 用法：
 *   npm run deploy                          # 构建 + 推送到默认仓库
 *   npm run deploy -- --dry-run             # 只构建与准备，看清会动哪些文件，不提交不推送
 *   npm run deploy -- --no-build            # 复用现有 dist/
 *   npm run deploy -- --base=/              # 换成自有域名（根路径部署）
 *   npm run deploy -- --repo=<另一个仓库地址>
 *
 * 对应的 GitHub Pages 设置：Settings → Pages → Source = Deploy from a branch，
 * 分支 `main`、目录 `/ (root)`。站点地址是 `https://<owner>.github.io/<repo>/`，
 * `--base` 必须与这条地址的路径一致，否则白屏（资源 404）。
 *
 * 需要 HTTPS：Service Worker 与「添加到主屏」都要求安全上下文，GitHub Pages 自带。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')
const DEFAULT_REPO = 'https://github.com/NianZheChao/foodAndWorkout_deploy.git'

function parseArgs(argv) {
  const options = { build: true, dryRun: false, repo: process.env.DEPLOY_REPO ?? DEFAULT_REPO, base: undefined, message: undefined }
  for (const arg of argv) {
    if (arg === '--no-build') options.build = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length)
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length)
    else if (arg.startsWith('--message=')) options.message = arg.slice('--message='.length)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/deploy-pages.mjs [--repo=<url>] [--base=/<repo>/] [--message=<文本>] [--no-build] [--dry-run]')
      process.exit(0)
    } else {
      throw new Error(`不认识的参数：${arg}（--help 看用法）`)
    }
  }
  return options
}

/** 仓库地址 → 项目名。项目名就是 GitHub Pages 项目页的路径段，默认 base 由它推出来。 */
function projectNameOf(repoUrl) {
  const last = repoUrl.replace(/\/+$/, '').split('/').pop() ?? ''
  const name = last.replace(/\.git$/, '')
  if (!name) throw new Error(`看不懂的仓库地址：${repoUrl}`)
  return name
}

/** `https://github.com/<owner>/<repo>.git` → `<owner>`；认不出来就返回 undefined。 */
function ownerOf(repoUrl) {
  return /github\.com[/:]([^/]+)\//.exec(repoUrl)?.[1]
}

function runGit(args) {
  execFileSync('git', args, { stdio: 'inherit' })
}

/** 只用来读信息（失败返回 undefined，不打印 git 的报错）。 */
function readGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return undefined
  }
}

function runNode(scriptPath, args = []) {
  execFileSync(process.execPath, [join(root, scriptPath), ...args], { cwd: root, stdio: 'inherit' })
}

const { build, dryRun, repo, base: baseArg, message } = parseArgs(process.argv.slice(2))
const project = projectNameOf(repo)
const base = (baseArg ?? `/${project}/`).replace(/\/*$/, '/')
const siteUrl = `https://${(ownerOf(repo) ?? '<owner>').toLowerCase()}.github.io/${project}/`

// 0) 源头脏工作区只提醒，不拦：部署的是已提交 + 未提交的现状，作者自己清楚就行。
const sourceDirty = readGit(['-C', root, 'status', '--porcelain'])
if (sourceDirty) console.log('[deploy] 提醒：应用仓库有未提交的改动，这次发布的是当前工作区构建出来的产物')

// 1) 构建：类型检查 + 生产构建。base 决定产物里的资源地址，必须与站点路径一致。
if (build) {
  console.log(`[deploy] 构建（base=${base}）`)
  runNode('node_modules/vue-tsc/bin/vue-tsc.js', ['-b'])
  runNode('node_modules/vite/bin/vite.js', ['build', `--base=${base}`])
}
if (!existsSync(join(distDir, 'index.html'))) throw new Error(`构建产物不存在：${distDir}/index.html（先 npm run build）`)

// 2) 准备部署仓库（缓存在系统临时目录里，不进本体仓库）。
//    复用同一个克隆而不是每次重 clone：部署仓库的历史保持线性，推送也就不需要 --force。
const tmpRoot = resolve(tmpdir())
const cacheDir = resolve(tmpRoot, `thin-muscle-plan-pages-${project}`)
if (!cacheDir.startsWith(tmpRoot + sep)) throw new Error(`部署目录跑到临时目录外面了：${cacheDir}`)

if (existsSync(cacheDir) && !existsSync(join(cacheDir, '.git'))) rmSync(cacheDir, { recursive: true, force: true })
if (!existsSync(join(cacheDir, '.git'))) {
  console.log(`[deploy] 克隆 ${repo}`)
  runGit(['clone', '--quiet', repo, cacheDir])
}
runGit(['-C', cacheDir, 'fetch', '--quiet', '--prune', 'origin'])
if (readGit(['-C', cacheDir, 'rev-parse', '--verify', '--quiet', 'origin/main'])) {
  runGit(['-C', cacheDir, 'checkout', '--quiet', '-B', 'main', 'origin/main'])
} else {
  // 空仓库：克隆下来就是一个「还没出生」的分支，把分支名摆正即可
  runGit(['-C', cacheDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
}

// 3) 用产物替换工作区（`.git` 留着，其余全清 —— 上一版删掉的文件不能留在站点上）。
for (const entry of readdirSync(cacheDir)) {
  if (entry === '.git') continue
  rmSync(join(cacheDir, entry), { recursive: true, force: true })
}
cpSync(distDir, cacheDir, { recursive: true })

// 4) 托管侧的两个补丁文件。
//    `.nojekyll`：GitHub Pages 默认拿 Jekyll 处理分支内容，没有它会丢掉下划线开头的文件。
//    `404.html`：SPA 回退。从主屏冷启动会直接请求 `/today`，GitHub Pages 把未知路径交给 404.html，
//    而它就是 index.html，路由照样能接上（根路径部署同样需要）。
//    `.gitattributes`：产物仓库不要任何行尾转换 —— 否则每个文件都要过 `core.autocrlf` 一遍
//    （工作量全变成行尾噪声），二进制更不该被碰。
writeFileSync(join(cacheDir, '.nojekyll'), '')
writeFileSync(join(cacheDir, '.gitattributes'), '* -text\n')
copyFileSync(join(cacheDir, 'index.html'), join(cacheDir, '404.html'))
writeFileSync(
  join(cacheDir, 'README.md'),
  [
    '# 薄肌计划（PWA）· 部署仓库',
    '',
    '这个仓库里**只有构建产物**，由源仓库的 `npm run deploy`（`app/scripts/deploy-pages.mjs`）自动推送。',
    '请不要手工改这里的文件 —— 下一次发布会整个覆盖。',
    '',
    `- 站点：${siteUrl}`,
    '- 源仓库：应用本体、需求 / 设计 / 进度文档、验收测试都在那边',
    '- GitHub Pages 设置：Source = Deploy from a branch，分支 `main`，目录 `/ (root)`',
    '',
    '产物是纯静态文件，装到主屏后离线可用（Service Worker）；使用者的记录只存在各自设备的浏览器里，服务器不留数据。',
    ''
  ].join('\n')
)

// 5) 提交与推送。
runGit(['-C', cacheDir, 'add', '-A'])
const staged = readGit(['-C', cacheDir, 'status', '--porcelain'])
if (!staged) {
  console.log('[deploy] 产物与上一版一致，没有要提交的东西')
  process.exit(0)
}
if (dryRun) {
  console.log('[deploy] --dry-run：以下改动会被提交（没有真的提交）')
  console.log(staged)
  process.exit(0)
}
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
const revision = readGit(['-C', root, 'rev-parse', '--short', 'HEAD']) ?? 'unknown'
runGit(['-C', cacheDir, 'commit', '--quiet', '-m', message ?? `deploy: 源仓库 ${revision}（${stamp} UTC）`])
runGit(['-C', cacheDir, 'push', '--quiet', 'origin', 'main'])
console.log(`[deploy] 已推送。站点：${siteUrl}`)