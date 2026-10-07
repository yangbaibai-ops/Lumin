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
    // 波次 2 从 fileOps.ts 抽出来的**原子写唯一实现**：它写的是
    // `<目标>.<8位随机>.lumin-tmp` 临时文件，再 fsync + rename —— 绝不对用户文档直接落盘。
    // 抽出来的理由正是报告 §6.2：那段代码最该被单测钉住，而它原来在 import electron 的
    // 文件里进不了 node --test（现在 tests/atomicWrite.test.mjs 有 10 条 IO 断言）。
    'services/atomicWrite.ts',
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

test('拖放链：内层认领的信号是 stopPropagation，不是恒真的 defaultPrevented（d014773 回归的守卫）', () => {
  /**
   * ⚠️ 这条测试的**上一版**把回归当成正确行为钉住了，值得写下来当教训：
   *
   *   它断言 `EditorView.vue` 的 `onDrop` 里必须有 `if (e.defaultPrevented) return`，
   *   理由（d014773）是"图片拖入由内核 handleDrop 处理，它只 preventDefault 不 stopPropagation，
   *   事件继续冒泡到外层，于是拖 png 会『图片插进去了 + 同时弹一条不支持的文件类型』"。
   *   但那个模板写的是 `@drop.prevent="onDrop"` —— Vue 的 `.prevent` 修饰器
   *   （`withModifiers` 的 `modifierGuards.prevent`）**先** `preventDefault()`，**再**调处理函数。
   *   于是进了 `onDrop` 之后 `defaultPrevented` **恒为 true**：第一行就 return，
   *   **拖 .md 不打开、拖 .png 连提示都没有**（"连提示都没有"正是它恒真的铁证）。
   *   静态守卫看不出来（那一行确实"在"），只有真派发一次拖放才看得见 —— 这正是本条改成
   *   "运行时套件 + 这里守契约"的原因。
   *
   * 现在的契约（三处，缺一处就会重演）：
   *   ① 内层认领 = `lib/editor/imagePaste.ts` 的 `event.stopPropagation()`（事件不再冒泡出去）；
   *   ② 窗口级落点只有一份：`App.vue` 的 `[data-drop-window]`（`@drop.prevent` + `@dragover`，
   *      `@dragover` 必须 preventDefault，否则浏览器根本不派发 drop）；
   *   ③ **任何**文件都别再拿 `defaultPrevented` 判"内层已认领这次拖放"（它是恒真的）。
   *
   * 运行时那一半在 `tools/_verify-drop-open.js`（已进默认矩阵）：用 CDP
   * `Input.dispatchDragEvent`（`DragData.files` = 真实磁盘路径）真拖一次 .md / 文件夹 / 图片 ——
   * 上一版注释里"CDP 造出来的 File 没有真实路径、到不了 toast 分支"的说法已被实测推翻
   * （`webUtils.getPathForFile` 拿得到真实路径），所以那半条**不再是**未证事项。
   */
  const ip = read('src/renderer/src/lib/editor/imagePaste.ts')
  assert.match(
    ip,
    /event\.stopPropagation\(\)/,
    '图片认领一次拖放之后必须 stopPropagation（否则窗口级会出现"不支持的文件类型"双弹）'
  )

  const app = read('src/renderer/src/App.vue')
  assert.match(app, /@drop\.prevent="onWindowDrop"/, '窗口根节点必须挂着 drop 处理')
  const dragOverAt = app.indexOf('async function onWindowDragOver(')
  assert.ok(dragOverAt > 0, 'App.vue 里找不到窗口级 onWindowDragOver')
  assert.match(
    app.slice(dragOverAt, dragOverAt + 300),
    /preventDefault\(\)/,
    'onWindowDragOver 必须 preventDefault（否则浏览器不会派发 drop，甚至会导航到那个文件）'
  )
  assert.match(app, /data-drop-window/, '窗口根节点要有 data-drop-window 语义锚点（套件按它定位）')

  // 回归指纹：渲染层不许再用 `defaultPrevented` 当"这次拖放已经被人处理过"的判据。
  // （文字里提到它是允许的 —— 上面这些注释就在讲这件事；真正要拦的是**代码**里的读取，
  //   所以只比对"非注释行"。）
  //
  // 唯一的例外：`lib/keymap/service.ts` 读的是 **keydown** 的 `defaultPrevented`
  // （"内层已经处理过这个键就让行"）—— 键盘事件上这个判据是**真的**
  // （没人用 `@keydown.prevent` 把它提前置真），与拖放那条恒真陷阱不是一回事。
  const stripComments = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1')
  const offenders = []
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (/\.(ts|vue)$/.test(e.name)) {
        const body = stripComments(read(rel))
        if (/\.defaultPrevented/.test(body) && !rel.endsWith('keymap/service.ts')) {
          offenders.push(rel)
        }
      }
    }
  }
  walk('src/renderer/src')
  assert.deepEqual(
    offenders,
    [],
    '这些文件又拿 event.defaultPrevented 做判据了（@drop.prevent 下它恒真，会整条关掉拖放打开）：\n' +
      offenders.join('\n')
  )

  // 旧实现的两个"旧址"：处理函数搬走了就不该再各留一份（两份实现 = 落点会漂）。
  // 只看 `<template>` 那一段 —— 上面那些解释里**提到**旧写法是正当的。
  const ev = read('src/renderer/src/views/EditorView.vue')
  const evTemplate = ev.slice(ev.indexOf('<template>'))
  assert.doesNotMatch(
    evTemplate,
    /@drop/,
    'EditorView 的模板不该再挂 drop 处理（窗口级 App.vue 已经有一份，两份会让落点漂）'
  )
  assert.doesNotMatch(
    ev,
    /^async function onDrop\(/m,
    'EditorView 不该再自己定义 onDrop（实现只有 lib/droppedPath.ts 一份）'
  )

  /**
   * ─── 根因取证：把"为什么 `defaultPrevented` 恒真"钉在单测里 ────────────────────
   *
   * 这一条读的是 Vue 自己的实现（`node_modules/@vue/runtime-dom`），不是我们的代码 ——
   * 目的是让**判据的来源**可被机器复核：`withModifiers` 先跑守卫、再调处理函数，
   * 而 `prevent` 守卫就是 `e.preventDefault()`。于是 `@drop.prevent="fn"` 里的 `fn`
   * 看到 `defaultPrevented === true` 是**框架语义**上的必然，不是"某次手滑"。
   *
   * 现场：`EditorView.vue`（HEAD 84cec62）第 699 行 `if (e.defaultPrevented) return`、
   * 模板第 827 行 `@drop.prevent="onDrop"`，由 d014773 引入（本测试的上一版还把它当正确行为守着）。
   */
  const vueRuntime = readFileSync(
    join(ROOT, 'node_modules', '@vue', 'runtime-dom', 'dist', 'runtime-dom.esm-bundler.js'),
    'utf8'
  )
  const wmAt = vueRuntime.indexOf('const withModifiers =')
  assert.ok(wmAt > 0, 'Vue 运行时里找不到 withModifiers（升级 Vue 后请复核这条判据的来源）')
  const wm = vueRuntime.slice(wmAt, wmAt + 600)
  const guardAt = wm.indexOf('guard(event, modifiers)')
  const callAt = wm.indexOf('return fn(event')
  assert.ok(
    guardAt > 0 && callAt > guardAt,
    'Vue 的 withModifiers 语义变了：守卫（含 .prevent）必须仍在处理函数之前调用'
  )
  assert.match(
    vueRuntime,
    /prevent: \(e\) => e\.preventDefault\(\)/,
    'Vue 的 .prevent 守卫必须还在'
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
