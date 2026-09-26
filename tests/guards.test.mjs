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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// 共享常量直接 import .ts（node --test 的类型剥离）：断言"两处用的是同一份"，而不是比字符串
import { PROD_CSP, devCsp } from '../src/shared/csp.ts'

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

test('CSP：默认自限 + 脚本只允许 self（唯一真相源 = src/shared/csp.ts）', () => {
  const html = read('src/renderer/index.html')
  // 单一真相源：index.html 里**只有占位**，不许再出现硬编码的 CSP meta
  assert.match(html, /<!--LUMIN_CSP-->/, 'index.html 必须保留 CSP 占位注释（构建期注入）')
  // 判"没有硬编码"前先剥掉 HTML 注释：注释里**解释**这段历史是正当的
  // （本轮就在这里写了"此前是什么样"，不剥注释会把说明文字当成硬编码，属于假红）
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(
    htmlNoComments,
    /<meta[^>]*http-equiv="Content-Security-Policy"/i,
    'index.html 不许再手写 CSP（真相源在 src/shared/csp.ts，由 electron.vite.config.ts 注入）'
  )
  const content = PROD_CSP
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
  // 打包态不许放行任意 ws:/wss:（那是"万一被注入"时的数据外发通道；dev 由 devCsp() 单独放行）
  assert.doesNotMatch(content, /connect-src[^;]*\bwss?:/, '生产 CSP 的 connect-src 不许含 ws:/wss:')
  // 本地图片/音视频必须被放行（否则打包态文档里的相对路径图片全加载不出来）
  assert.match(content, /img-src[^;]*lumin-file:/, 'img-src 必须放行 lumin-file:')
  assert.match(content, /media-src[^;]*lumin-file:/, 'media-src 必须放行 lumin-file:')
  // 主进程的响应头必须用同一个常量，而不是再写一遍字面量
  const main = read('src/main/index.ts')
  assert.match(main, /'Content-Security-Policy':\s*\[PROD_CSP\]/, '主进程必须用共享的 PROD_CSP')
  assert.doesNotMatch(
    main,
    /'Content-Security-Policy':\s*\[\s*['"]default-src/,
    '主进程不许内联写 CSP 字面量'
  )
  // dev 与 prod 的差别只有 ws（HMR）
  assert.match(devCsp(), /connect-src[^;]*ws:/, 'dev CSP 必须放行 ws（HMR）')
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

test('窗口级拖放的落点判定：内层认领过的拖放不再往下判（审计 §7 复查）', () => {
  /**
   * 背景：图片拖入是内核 `handleDrop`（`lib/editor/imagePaste.ts`）在处理，它 `preventDefault`
   * 但**不 stopPropagation**，事件继续冒泡到 `EditorView.vue` 的窗口级 `onDrop`；而后者只认
   * .md/.txt 后缀 —— 于是拖一张 png 进来会「图片真的插进去了 + 同时弹一条不支持的文件类型」。
   *
   * 为什么这条只能是**静态**守卫（诚实说明）：CDP 里造出来的 `File` 没有真实文件系统路径，
   * `webUtils.getPathForFile()` 会返回空串，外层 handler 在"没路径"处就 return 了 ——
   * 也就是说从合成事件走**到不了**那条 toast 分支，用它做运行时断言等于什么都没验。
   * 真拖放要在用户机器上手动确认（拖一张 png 进编辑区：图片进正文、**没有** error 提示）。
   * 静态守卫至少保证那一行短路不会被人顺手删掉。
   */
  const src = read('src/renderer/src/views/EditorView.vue')
  const at = src.indexOf('async function onDrop(')
  assert.ok(at > 0, 'EditorView.vue 里找不到 onDrop')
  const body = src.slice(at, at + 400)
  assert.match(
    body,
    /if \(e\.defaultPrevented\) return/,
    'onDrop 必须先用 e.defaultPrevented 短路（内层已经处理过这次拖放）'
  )
  const dragOver = src.slice(
    src.indexOf('function onDragOver('),
    src.indexOf('function onDragOver(') + 200
  )
  assert.match(
    dragOver,
    /preventDefault\(\)/,
    'onDragOver 仍要 preventDefault（否则浏览器会打开这个文件）'
  )
})

test('许可与第三方声明：LICENSE 存在、声明会被打进产物、且门禁校验它是最新的', () => {
  // 背景（审计 §5）：README 一直声明 MIT，而仓库既没有 LICENSE 也没有 package.json 的 license 字段；
  // 打包产物里第三方库的版权声明又被 Rollup 全剥掉了。这一条把"补上的东西不会悄悄回退"钉住。
  assert.ok(existsSync(join(ROOT, 'LICENSE')), 'LICENSE 文件必须存在')
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.license, 'MIT', 'package.json 必须有 license 字段（与 README/LICENSE 一致）')
  assert.equal(pkg.private, true, 'package.json 必须是 private（防止误发布到公共 registry）')
  assert.ok(
    existsSync(join(ROOT, 'THIRD-PARTY-NOTICES.md')),
    'THIRD-PARTY-NOTICES.md 必须存在（npm run notices）'
  )
  assert.ok(
    pkg.scripts.notices && pkg.scripts['notices:check'],
    '必须有 notices / notices:check 脚本'
  )
  assert.match(pkg.scripts.ci, /notices:check/, 'CI 门禁必须校验许可声明是最新的（否则会悄悄漂）')
  const yml = read('electron-builder.yml')
  assert.doesNotMatch(yml, /THIRD-PARTY-NOTICES/, '打包配置不许排除许可声明文件')
  // 声明的正文里要带许可分布与包清单（防止生成脚本退化成空文件）
  const notices = read('THIRD-PARTY-NOTICES.md')
  assert.match(notices, /\| 许可 \| 包数量 \|/, '声明里必须有许可分布表')
  assert.match(notices, /\| 包 \| 版本 \| 许可 \| 仓库 \|/, '声明里必须有包清单表')
  assert.match(notices, /MIT/, '声明里必须出现 MIT')
})
