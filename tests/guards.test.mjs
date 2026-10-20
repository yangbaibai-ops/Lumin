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
import {
  PROD_CSP,
  devCsp,
  CSP_HEADER_ONLY,
  META_IGNORED_CSP_DIRECTIVES
} from '../src/shared/csp.ts'
// 反馈渠道配置（URL 的唯一真相源；见下面那条「反馈渠道」守卫）
import { FEEDBACK_CHANNELS, isAllowedFeedbackUrl } from '../src/shared/feedback.ts'

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
  // 主进程的响应头必须用共享常量，而不是再写一遍字面量
  const main = read('src/main/index.ts')
  assert.match(
    main,
    /'Content-Security-Policy'\]\s*=\s*\[CSP_HEADER_ONLY\]/,
    '主进程的响应头必须用共享的 CSP_HEADER_ONLY（meta 无效的指令只走头）'
  )
  assert.doesNotMatch(
    main,
    /'Content-Security-Policy'[^\n]*\[\s*['"]default-src/,
    '主进程不许内联写 CSP 字面量'
  )
  // dev 与 prod 的差别只有 ws（HMR）
  assert.match(devCsp(), /connect-src[^;]*ws:/, 'dev CSP 必须放行 ws（HMR）')
})

test('CSP：meta 版里不许出现「meta 里会被忽略」的指令（否则等于没设）', () => {
  /**
   * 用户实测的控制台输出（DevTools 里那条红）：
   *   `The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a
   *    <meta> element.`
   * 也就是 `frame-ancestors` 写在 `<meta>` 里**根本没生效**（"以为设了其实没设"）。
   * CSP 规范明文：`frame-ancestors` / `report-uri` / `sandbox` 通过 `<meta>` 下发时被忽略
   * （Chromium 会打上面那条警告）。所以要下发它们只能走**响应头**（`CSP_HEADER_ONLY`）。
   *
   * 这条测试遍历 `META_IGNORED_CSP_DIRECTIVES`，把"再写回去"变成红灯 —— 注释拦不住人，测试能。
   */
  assert.ok(META_IGNORED_CSP_DIRECTIVES.length >= 3, 'meta 无效指令清单太短，核对口径可能不对')
  for (const directive of META_IGNORED_CSP_DIRECTIVES) {
    assert.doesNotMatch(
      PROD_CSP,
      new RegExp(`(^|;\\s*)${directive}\\b`),
      `PROD_CSP 进了 <meta>，不许含 ${directive}（meta 里会被忽略 → 等于没设）；要用就走 CSP_HEADER_ONLY`
    )
    // meta 版与头版**不许**重复同一条指令：头 + meta 两份策略取交集，重复只会带来漂移风险
    assert.doesNotMatch(
      CSP_HEADER_ONLY,
      new RegExp(`(^|;\\s*)${directive}\\b.*${directive}\\b`),
      `${directive} 在头里重复了`
    )
  }
  // 头那份必须真的带着 frame-ancestors（否则我们就把这条防护彻底弄丢了）
  assert.match(
    CSP_HEADER_ONLY,
    /frame-ancestors\s+'none'/,
    'CSP_HEADER_ONLY 必须含 frame-ancestors'
  )
  assert.doesNotMatch(
    PROD_CSP,
    /frame-ancestors/,
    'PROD_CSP 与 CSP_HEADER_ONLY 的职责：前者进 meta、后者走响应头，不许混'
  )
})

test('CSP：响应头不分 dev/prod 都要注册（开发态 http 与打包态 file:// 都覆盖）', () => {
  /**
   * 为什么单测守这条：旧实现是 `if (!is.dev && !cspInstalled)` —— 开发态**完全不注册**，
   * 而开发态恰恰是用户能看见控制台的那一态（他看到的正是开发态那条警告）。
   * 现在这条策略与构建态无关：`onHeadersReceived` 不设 filter，dev（`http://localhost:5173`）
   * 与 prod（`file://` 文档 + `lumin-file://` 图片）都走同一条注册。
   * 真窗口里"头到底有没有下发"由 `tools/_verify-csp.js` 读响应头来验（静态测试做不到）。
   */
  const main = read('src/main/index.ts')
  assert.match(
    main,
    /electronSession\.defaultSession\.webRequest\.onHeadersReceived/,
    '必须用 defaultSession 注册'
  )
  assert.doesNotMatch(
    main,
    /!is\.dev\s*&&\s*!cspHeaderInstalled/,
    'CSP 响应头不许再被 !is.dev 挡住（开发态也要下发）'
  )
  assert.match(
    main,
    /if\s*\(\s*!cspHeaderInstalled\s*\)/,
    '注册必须只做一次（session 是所有窗口共享的）'
  )
  // 不许给 onHeadersReceived 设 URL 过滤（设了就容易漏掉 file:// 或 lumin-file://）
  assert.doesNotMatch(
    main,
    /onHeadersReceived\(\s*\{/,
    'onHeadersReceived 不许带 filter：开发态是 http://localhost:5173、打包态是 file:// + lumin-file://'
  )
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

test('反馈渠道：URL 只在一处配置、必须 https、三语文案齐全', () => {
  /**
   * 用户口径：「在顶部栏『帮助』中增加一个选项**『意见或 bug 反馈』**，点击后出现项目的 issue
   * 提交处（**可能有多个：github、gitee 等**）」⇒ 加渠道 = 在 `shared/feedback.ts` 加一条数据。
   * 这条守三件事：
   *   ① URL 只在那一份配置里（`.vue` 模板里不许出现硬编码 URL）；
   *   ② 每条渠道的 URL 必须是 https（配置面白名单；运行时的第二道闸在主进程
   *      `services/links.ts` 的 `safeExternalUrl`，两者是纵深防御，不是重复实现）；
   *   ③ 渠道名的 i18n 键在三份语言包里都存在且非空（渠道名是品牌名，三语同形是刻意的）。
   */
  assert.ok(FEEDBACK_CHANNELS.length >= 1, '至少要有 GitHub 一条')
  for (const ch of FEEDBACK_CHANNELS) {
    assert.ok(isAllowedFeedbackUrl(ch.url), `${ch.id} 的 URL 必须是 https：${ch.url}`)
    assert.match(ch.labelKey, /^menu\./, `${ch.id} 的渠道名要走 menu.* 语言包键`)
    for (const lang of ['zh-CN', 'en-US', 'ru-RU']) {
      const pack = JSON.parse(read(`src/shared/i18n/${lang}.json`))
      const value = ch.labelKey.split('.').reduce((a, k) => (a == null ? a : a[k]), pack)
      assert.equal(
        typeof value === 'string' && value.trim().length > 0,
        true,
        `${lang} 缺 ${ch.labelKey}（加渠道时要三语都补）`
      )
    }
  }
  // 负例：非 https 一律被配置面判据拒掉（`javascript:` 交给系统处理器 = 代码执行面）
  for (const bad of [
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'http://github.com/x',
    'mailto:a@b.c',
    ''
  ]) {
    assert.equal(isAllowedFeedbackUrl(bad), false, `应当拒绝：${bad}`)
  }
  // 模板里不许硬编码 URL：渠道数据只能来自共享配置
  const menuBar = read('src/renderer/src/components/TopMenuBar.vue')
  assert.doesNotMatch(
    menuBar,
    /https?:\/\//,
    'TopMenuBar.vue 里不许出现 URL（渠道地址只放 src/shared/feedback.ts）'
  )
  assert.match(
    menuBar,
    /from '\.\.\/\.\.\/\.\.\/shared\/feedback'/,
    'TopMenuBar 必须从共享的渠道清单取数据'
  )
})

test('落盘：用户文档必须走 fileOps.writeFile（原子写），直接写盘的文件要逐个登记', () => {
  /**
   * 允许直接写盘的例外（**每一条都要写清理由**）：
   *   * `fileOps.ts` —— 原子写的实现本身；
   *   * `drafts.ts` —— 写的是我们自己的草稿文件（`<userData>/drafts/*`），不是用户的文档；
   *   * `export.ts` —— 写导出产物（用户在保存对话框里选定的输出路径）；
   *   * `services/links.ts` —— 用 `flag: 'wx'` **新建**链接目标，文件已存在时会失败，绝不覆盖；
   *   * `services/*` —— 写各自的元数据/缓存，同样不经手用户的 `.md`；
   *   * `printPreview.ts` —— 写的是**打印预览的临时产物**（`<temp>/lumin-print-preview-<id>/`：
   *     一份 PDF + 一页 wrapper HTML），既不是用户文档、也不该走"原子写 + fsync"那套
   *     （它就是给人看一眼就删的一次性文件，关窗/退出都会删掉）。
   * 用户文档的保存路径只有 `ipc.ts` 的保存分支，它必须调 `fileOps.writeFile`。
   */
  const ALLOW = [
    'fileOps.ts',
    // 波次 2 从 fileOps.ts 抽出来的**原子写唯一实现**：它写的是
    // `<目标>.<8位随机>.lumin-tmp` 临时文件，再 fsync + rename —— 绝不对用户文档直接落盘。
    // 抽出来的理由正是报告 §6.2：那段代码最该被单测钉住，而它原来在 import electron 的
    // 文件里进不了 node --test（现在 tests/atomicWrite.test.mjs 有 10 条 IO 断言）。
    'services/atomicWrite.ts',
    'drafts.ts',
    'export.ts',
    'printPreview.ts',
    'services/links.ts',
    'services/database.ts',
    'services/history.ts',
    'services/taskbar.ts',
    // 启动诊断导出：写的是**用户通过保存对话框选定的诊断文件**（`startup.log` + 环境摘要，
    // 本身不含文档内容，也不是用户的 .md）；与 export.ts 同属"用户在对话框里选落点"的产物。
    'services/startupLog.ts'
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

test('拖拽全禁用：入口统一拦截、各组件不再有拖拽源/落点/放置指示', () => {
  // ① 入口：window 捕获阶段拦 dragstart + drop（见 lib/dragGuard.ts）
  const main = read('src/renderer/src/main.ts')
  assert.match(main, /installDragGuard\(window\)/, '入口必须装 window 级拖拽拦截')
  assert.match(
    main,
    /installNonDraggableDom\(document\)/,
    '入口必须把 DOM 拖拽源钉成 draggable=false'
  )
  const guard = read('src/renderer/src/lib/dragGuard.ts')
  for (const type of ['dragstart', 'dragenter', 'dragover', 'drop']) {
    assert.match(guard, new RegExp(`'${type}'`), `dragGuard 必须拦截 ${type}`)
  }
  assert.match(guard, /preventDefault\(\)/, '拦截必须 preventDefault（否则幽灵图/禁用光标都不对）')
  assert.match(guard, /stopPropagation\(\)/, '拦截必须在捕获阶段切断，页面内处理器一个都不该收到')
  assert.match(guard, /capture:\s*true/, '必须用捕获阶段（capture: true）')
  assert.doesNotMatch(
    guard,
    /addEventListener\(\s*['"](mousedown|mousemove|mouseup)/,
    '拖选依赖鼠标事件，拦截器不许碰 mousedown/mousemove/mouseup'
  )

  // ② 窗口/编辑器不再有 drop 落点（文件拖入不打开、图片不插入）
  const app = read('src/renderer/src/App.vue')
  assert.doesNotMatch(
    app,
    /@drop|@dragover|data-drop-window|handleDroppedEvent/,
    'App.vue 不许再挂窗口级拖放落点'
  )
  const imagePaste = read('src/renderer/src/lib/editor/imagePaste.ts')
  assert.doesNotMatch(imagePaste, /handleDrop\(/, '图片插件不许再处理 drop（拖入图片已禁用）')
  assert.match(imagePaste, /handlePaste/, '粘贴图片必须保留（Ctrl+V 不受影响）')
  const extensions = read('src/renderer/src/lib/editor/extensions.ts')
  assert.doesNotMatch(extensions, /^\s*NoTextDrag,/m, 'NoTextDrag 必须从扩展注册表里消失')
  assert.doesNotMatch(extensions, /dropCursor/, 'dropCursor 必须从扩展集里消失')
  assert.match(extensions, /draggable:\s*false/, 'Image 节点必须从 schema 层不可拖')

  // ③ 文件树：draggable=false、无 drag*/drop 处理、无落点高亮
  const treeNode = read('src/renderer/src/components/TreeNode.vue')
  assert.match(treeNode, /draggable="false"/, '树行必须显式 draggable="false"')
  assert.doesNotMatch(
    treeNode,
    /@dragstart=|@dragend=|@dragover=|@dragleave=|@drop=|'is-drop-target'/,
    '树行不许再挂拖放处理/落点样式'
  )
  const fileTree = read('src/renderer/src/components/FileTree.vue')
  assert.doesNotMatch(
    fileTree,
    /@drop|@dragover|@dragend|onDrop|onDragOver/,
    '文件树容器不许再挂拖放处理'
  )
  const sidebar = read('src/renderer/src/assets/sidebar.css')
  assert.doesNotMatch(sidebar, /is-drop-target/, '落点高亮样式必须删除')

  // ④ 样式/指示：全局 user-drag:none、无 dropcursor / 拖拽动效、无 !important
  const base = read('src/renderer/src/assets/base.css')
  assert.match(base, /-webkit-user-drag:\s*none/, '必须有全局 -webkit-user-drag: none')
  assert.doesNotMatch(base, /-webkit-user-drag[^;]*!important/, '禁用拖拽不许用 !important')
  const css = [
    'base.css',
    'markdown.css',
    'sidebar.css',
    'editor.css',
    'overlays.css',
    'chrome.css',
    'components.css',
    'style.css'
  ]
    .map((f) => read(`src/renderer/src/assets/${f}`))
    .join('\n')
  assert.doesNotMatch(css, /ProseMirror-dropcursor|\.cm-dropCursor/, '放置指示线样式必须不存在')
  assert.doesNotMatch(css, /cursor:\s*(grab|grabbing|move)\b/, '不许留下可拖拽光标')
  const cb = read('src/renderer/src/components/editor/CodeBlockView.vue')
  assert.doesNotMatch(cb, /['"]\.cm-dropCursor['"]/, '代码块不许配置放置指示线')
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

test('设置只有一个写入口（主进程不许绕过去直接写 kv / 写 electron-store）', () => {
  /**
   * 报告 §3.2 P0-1/P0-2：设置此前是"两处真相" ——
   *   * `main/menu.ts` 的原生菜单主题项写的是 **electron-store**（`store.ts` 自述它只是
   *     历史配置的一次性迁移源），渲染层收到 `theme-changed` 却去 SQLite 重读 ⇒ 点了没反应；
   *   * `ipc.ts` 里有两处（备份目录选择 / 恢复默认）直接 `db.kvSet('settings', …)`，
   *     写完不通知渲染层 ⇒ 界面显示旧值到重启（反之 store 的 persist 还会把它打回去）。
   * 现在主进程侧只有 `services/appSettings.ts` 能写设置
   * （kv + 原生主题 + 广播 `settings:changed`）。这条守卫把"新增一处旁路"变成 CI 里的红灯。
   */
  const menu = read('src/main/menu.ts')
  assert.doesNotMatch(
    menu,
    /settingsStore/,
    '原生菜单不许再碰 electron-store（它只是历史配置的一次性迁移源，写进去没人读）'
  )
  assert.match(
    menu,
    /patchSettings\(\{\s*theme:/,
    '原生菜单的主题项必须走 appSettings.patchSettings'
  )

  // 允许写 settings 的文件：唯一写入口自己 + 一次性迁移（migrateLegacyStores）
  const ALLOW = new Set(['src/main/services/appSettings.ts', 'src/main/store.ts'])
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) {
        walk(rel)
        continue
      }
      if (!name.endsWith('.ts')) continue
      if (ALLOW.has(rel)) continue
      if (/kvSet\(\s*['"]settings['"]/.test(read(rel))) offenders.push(rel)
    }
  }
  walk('src/main')
  assert.deepEqual(
    offenders,
    [],
    '这些文件绕过了唯一写入口直接写 settings（请改用 services/appSettings 的 patchSettings/writeSettings）：\n' +
      offenders.join('\n')
  )
})
