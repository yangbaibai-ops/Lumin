// ─── 安全与数据安全的「不许回退」断言（自查报告 O6）─────────────────────────────
//
// 报告里记了一类风险：「改坏了很危险、但平时没人看」的配置与路径。
// 它们分别是：
//   * 窗口安全三件套（contextIsolation / nodeIntegration / sandbox）与 CSP；
//   * `shell.openExternal` 必须先过 scheme 白名单（否则 `javascript:` / `file:` 会被系统处理器接走）；
//   * 落盘必须走 `fileOps.writeFile`（同目录临时文件 + fsync + rename），不许随手 `fs.writeFile`；
//   * 卸载不许删用户数据（`deleteAppDataOnUninstall: false`）。
// 这些都能静态查清，所以放进单测 —— 谁把它们改坏了，`npm run ci` 立刻红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('窗口安全三件套不许回退（contextIsolation / nodeIntegration / sandbox）', () => {
  const src = read('src/main/index.ts')
  assert.match(src, /contextIsolation:\s*true/, 'contextIsolation 必须为 true')
  assert.match(src, /nodeIntegration:\s*false/, 'nodeIntegration 必须为 false')
  assert.match(src, /sandbox:\s*true/, 'sandbox 必须为 true（渲染进程不该有 Node）')
  // webSecurity / allowRunningInsecureContent 不许被显式打开
  assert.doesNotMatch(src, /webSecurity:\s*false/, 'webSecurity 不能被关掉')
  assert.doesNotMatch(src, /allowRunningInsecureContent:\s*true/, '不允许混内容')
})

test('CSP：默认自限 + 脚本只允许 self', () => {
  const html = read('src/renderer/index.html')
  const csp = /content="([^"]*Content-Security-Policy[^"]*|default-src[^"]*)"/.exec(html)
  const meta = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)
  assert.ok(meta, 'index.html 必须有 CSP meta')
  const content = meta[0]
  assert.match(content, /default-src\s+'self'/, 'default-src 必须是 self')
  assert.match(
    content,
    /script-src\s+'self'/,
    "script-src 必须是 'self'（不许 unsafe-inline/eval）"
  )
  assert.doesNotMatch(
    content,
    /script-src[^;]*unsafe-(inline|eval)/,
    'script-src 不许开 unsafe-inline / unsafe-eval'
  )
  void csp
})

test('openExternal 一律先过 scheme 白名单', () => {
  const links = read('src/main/services/links.ts')
  assert.match(
    links,
    /export function safeExternalUrl|safeExternal/,
    'links.ts 必须导出 URL 校验函数'
  )
  // 三处调用点都必须先校验再用
  for (const [file, pattern] of [
    ['src/main/index.ts', /safe/],
    ['src/main/ipc.ts', /safe/]
  ]) {
    const src = read(file)
    const calls = [...src.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1])
    assert.ok(calls.length > 0, `${file} 里应当有 openExternal 调用（改动了就同步这条断言）`)
    for (const arg of calls) {
      assert.ok(
        /safe|SAFE|ALLOW/.test(arg),
        `${file} 里 shell.openExternal(${arg}) 没经过白名单校验（见 services/links.ts）`
      )
    }
    void pattern
  }
})

test('落盘：用户文档必须走 fileOps.writeFile（原子写），直接写盘的文件要逐个登记', () => {
  /**
   * 允许直接写盘的例外（**每一条都要写清理由**）：
   *   * `fileOps.ts` —— 原子写的实现本身；
   *   * `drafts.ts` —— 写的是我们自己的草稿文件（`<userData>/drafts/*`），不是用户的文档；
   *   * `export.ts` —— 写导出产物（用户在保存对话框里选定的输出路径）；
   *   * `services/links.ts` —— 用 `flag: 'wx'` **新建**链接目标，文件已存在时会失败，绝不覆盖；
   *   * `services/*` —— 写各自的元数据/缓存，同样不经手用户的 `.md`。
   * 用户文档的保存路径只有 `ipc.ts` 的保存分支，它必须调 `fileOps.writeFile`。
   */
  const ALLOW = [
    'fileOps.ts',
    'drafts.ts',
    'export.ts',
    'services/links.ts',
    'services/database.ts',
    'services/history.ts',
    'services/taskbar.ts'
  ]
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.ts$/.test(name)) continue
      const rel = p.replace(/\\/g, '/').split('/src/main/')[1] ?? ''
      if (ALLOW.includes(rel)) continue
      const src = readFileSync(p, 'utf8')
      if (/fs\.writeFile|writeFileSync|fs\.createWriteStream/.test(src)) offenders.push(rel || p)
    }
  }
  walk(join(ROOT, 'src/main'))

  // 保存分支必须调用原子写
  const ipc = read('src/main/ipc.ts')
  assert.match(ipc, /fileOps\.writeFile\(/, '保存用户文档必须走 fileOps.writeFile')

  assert.deepEqual(
    offenders,
    [],
    '这些文件在直接写盘（用户文档的写入必须走 fileOps.writeFile 的原子写；若确属例外请加进本测试的 ALLOW 并写理由）：\n' +
      offenders.join('\n')
  )
})

test('卸载不许删用户数据（写作类应用的底线）', () => {
  const yml = read('electron-builder.yml')
  assert.match(yml, /deleteAppDataOnUninstall:\s*false/, 'deleteAppDataOnUninstall 必须为 false')
})
