// ─── 启动顺序的**确定量**门禁（窗口先出 / 库懒等待 / 非关键工作后置）──────────────
//
// 背景：用户报「Typora 打开 <1s，Lumin 5–6s」。时间类判据在 tools/_probe-boot.js
// （探针档，机器相关），这里只钉**结构性事实** —— 顺序一旦被改回去，套件立刻红：
//
//   ① 首窗**先建**，槽位延迟认领（restoreHead）；库在窗口建好之后才异步打开；
//   ② IPC 注册期统一套「先 await ensureDb()」的包装（懒等待，UI 不会被同步开库卡住）；
//   ③ 拼写检查 / 最近列表 / 跳转列表只在**首屏可交互之后**跑（startup:report）；
//   ④ 会话恢复计划在**窗口之后**才计算（渲染层认领槽位 / 首窗加载完）；
//   ⑤ 渲染层先认领槽位，再初始化 files（草稿键要用槽位）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const idx = read('src/main/index.ts')
const ipc = read('src/main/ipc.ts')
const preload = read('src/preload/index.ts')
const rendererMain = read('src/renderer/src/main.ts')

/** 去掉注释，避免注释里提到的函数名把"顺序断言"骗过去 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const idxCode = stripComments(idx)

test('窗口先建：首窗带 restoreHead + 200ms 兜底显示，且开库发生在建窗之后', () => {
  assert.match(idx, /restoreHead:\s*true/)
  assert.match(idx, /earlyShowMs:\s*150/)
  const firstWindow = idxCode.indexOf('const first = createWindow(')
  assert.ok(firstWindow > 0, '找不到首窗创建')
  // 建窗之后（同一个 whenReady 里）才 await 库、才补窗口外观
  const afterFirst = idxCode.slice(firstWindow)
  assert.ok(afterFirst.includes('await ensureDb()'), '建窗之后没有 await ensureDb()')
  assert.ok(afterFirst.includes('applyWindowSeed(first)'), '建窗之后没有补窗口外观')
  assert.match(idx, /startupMark\('window-seed-start'\)/)
  // 库打开入口本身让到下一轮事件循环（见 database.ts 的 ensureDatabase）
  assert.match(read('src/main/services/database.ts'), /setImmediate\(\(\) => \{/)
})

test('IPC 懒等待：每个 handler 先 await ensureDb()，注册结束立刻还原包装', () => {
  assert.match(ipc, /await slots\.ensureDb\(\)/)
  assert.match(ipc, /ipcMain\.handle = /)
  assert.match(ipc, /ipcMain\.on = /)
  assert.match(ipc, /ipcMain\.handle = rawHandle/)
  assert.match(ipc, /ipcMain\.on = rawOn/)
  // registerIpc 末尾还原（不让包装漏到 index.ts 自己注册的通道上）
  assert.match(ipc, /ipcMain\.handle = rawHandle\r?\n\s*ipcMain\.on = rawOn/)
  // 启动窗口槽位认领通道
  assert.match(ipc, /app:claimStartupSlot/)
})

test('拼写检查/最近列表/跳转列表只在首屏可交互之后的空闲任务里跑', () => {
  // 唯一实现必须在 runPostShowTasks 这一段里（顺序断言看的是"调用点"，不是定义位置）
  const postStart = idxCode.indexOf('const runPostShowTasks')
  const postEnd = idxCode.indexOf("ipcMain.on('startup:report'")
  assert.ok(postStart > 0 && postEnd > postStart, '找不到首屏后任务块')
  const postBlock = idxCode.slice(postStart, postEnd)
  for (const call of [
    'spellcheck.initializeSpellcheck()',
    'taskbar.refreshJumpList()',
    'taskbar.ensureShortcut()'
  ]) {
    assert.ok(postBlock.includes(call), `${call} 不在首屏后任务块里`)
    assert.equal(
      [...idxCode.matchAll(new RegExp(escapeRe(call), 'g'))].length,
      1,
      `${call} 只该出现一次（首屏后的空闲任务里）`
    )
  }
  // 触发点：渲染层上报 first-interactive
  const reportBlock = idxCode.slice(postEnd)
  assert.match(reportBlock, /stage === 'first-interactive'/)
  assert.match(reportBlock, /runPostShowTasks\(\)/)
  // 每个阶段都有开始/结束（便于用户在慢机器上定位）
  for (const stage of [
    'db-open-start',
    'db-open-end',
    'window-seed-start',
    'window-seed-end',
    'session-plan-start',
    'session-plan-end',
    'recent-list-start',
    'recent-list-end',
    'jump-list-start',
    'jump-list-end',
    'spellcheck-start',
    'spellcheck-end',
    'first-window-create-start',
    'first-window-create-end'
  ]) {
    assert.ok(idx.includes(`'${stage}'`), `startup.log 缺阶段：${stage}`)
  }
})

test('会话恢复计划在窗口之后才计算（planRestore 只出现在延迟闭包里）', () => {
  const firstWindow = idxCode.indexOf('const first = createWindow(')
  // planRestore 只有一处（ensureRestorePlan 里），不在 whenReady 顶层直接调用
  assert.equal(
    [...idxCode.matchAll(/session\.planRestore\(\)/g)].length,
    1,
    'planRestore 只该在 ensureRestorePlan 里调用一次'
  )
  const planFn = idxCode.slice(
    idxCode.indexOf('const ensureRestorePlan'),
    idxCode.indexOf('const claimStartupSlot')
  )
  assert.ok(planFn.includes('session.planRestore()'))
  // 调用点在首窗创建之后（认领槽位 / 其余窗口）
  const afterFirst = idxCode.slice(firstWindow)
  assert.ok(afterFirst.includes('ensureRestorePlan()'), '首窗之后没有调用 ensureRestorePlan')
  assert.match(idx, /const claimStartupSlot = async/)
})

test('渲染层：先认领槽位，再初始化 files；草稿键用当前槽位而不是启动参数快照', () => {
  const claim = rendererMain.indexOf('await ensureSessionSlot()')
  const filesInit = rendererMain.indexOf('await files.init(')
  assert.ok(claim > 0 && filesInit > claim, '必须先认领槽位再 files.init（草稿键要用它）')
  assert.match(read('src/renderer/src/lib/sessionSlot.ts'), /claimStartupSlot/)
  assert.match(read('src/renderer/src/stores/files.ts'), /currentSessionSlot\(\)/)
  assert.match(preload, /claimStartupSlot: \(\) => ipcRenderer\.invoke\('app:claimStartupSlot'\)/)
  assert.match(preload, /lumin-startup-head=1/)
})

test('日志保留最近 5 次（便于对比第一次慢、第二次快）', () => {
  const shared = read('src/shared/startupLog.ts')
  assert.match(shared, /MAX_STARTUP_LOG_FILES = 5/)
})

/** 正则转义（拼接函数名用） */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
