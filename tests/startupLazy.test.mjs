// ─── 大工作区懒加载判定（模拟慢环境：5000 文件）────────────────────────────────
//
// 实测（本机，隔离 profile）：5000 个文件的工作区让 `renderer-first-interactive`
// 从 ~520ms 涨到 ~1514ms，其中 `files` 段 +486ms（readDir + IPC）、随后递归渲染
// 5000 个 TreeNode 再占 ~320ms。首屏路径不该为"用户可能都不会看的目录树"付这笔钱。
//
// 这里钉两件事：① 纯判据 `planStartupTreeLoad` 的语义；② `files.init()` 真的不再
// 在首屏路径上 `await readDir`（防止以后有人"顺手改回去"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planStartupTreeLoad } from '../src/shared/startupLog.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('惰性判定：有根且未缓存才推迟到空闲；无根/已缓存不扫', () => {
  assert.equal(planStartupTreeLoad({ hasRoot: true, cached: false }), 'idle')
  assert.equal(planStartupTreeLoad({ hasRoot: true, cached: true }), 'skip')
  assert.equal(planStartupTreeLoad({ hasRoot: false, cached: false }), 'skip')
})

test('files.init 首屏路径上不再 await 目录扫描，且扫描排到 first-interactive 之后', () => {
  const src = read('src/renderer/src/stores/files.ts')
  const init = src.slice(src.indexOf('async init('), src.indexOf('loadRootWhenIdle(): void'))
  assert.doesNotMatch(
    init,
    /await this\.loadChildren\(this\.root\)/,
    'files.init 里不许再 await 根目录扫描：5000 文件时它要 ~486ms，直接压在首屏上'
  )
  // 也不能在 init 里就排空闲任务：空闲回调会抢在会话恢复的 IPC 前面，实测仍 1.5s
  assert.doesNotMatch(init, /this\.loadRootWhenIdle\(\)/)
  assert.match(src, /planStartupTreeLoad\(/)
  assert.match(src, /requestIdleCallback/)
  // 兜底超时要在 1s 内（否则侧栏可能长时间空着）
  assert.match(src, /timeout:\s*800/)

  const main = read('src/renderer/src/main.ts')
  const report = main.indexOf("reportStartup('first-interactive')")
  const load = main.indexOf('files.loadRootWhenIdle()')
  assert.ok(report > 0 && load > report, '目录树必须在 first-interactive 上报之后才排空闲加载')

  // 文件树自己的"页签切回自愈"仍然在（懒加载后缓存为空的唯一恢复路径）
  assert.match(read('src/renderer/src/components/FileTree.vue'), /void files\.loadChildren\(root\)/)
})
