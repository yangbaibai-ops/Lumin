// ─── 启动预算的**确定性**门禁（第十二轮「启动变慢了」）───────────────────────────
//
// 背景：启动耗时是机器相关量（磁盘缓存、杀软、并发实例），把它当默认矩阵里的硬阈值只会变成
// 环境噪声。所以分工是：
//   * **落在时间上**的判据 → `tools/_probe-boot.js`（探针档，多轮取中位数，自己打 PASS/FAIL）；
//   * **落在体积/结构上**的判据 → 这个文件（确定量，`npm test` 每次都守）。
//
// 这里钉三件事，都是本轮实测出来的因果：
//   ① 入口 CSS **不许再静态 `@import` KaTeX** —— 它会带进 59 条 `@font-face` + 全套排版规则，
//      把渲染阻塞的入口 CSS 从 ~111KB 抬回 143KB（实测），而首屏往往一个公式都没有；
//   ② KaTeX 样式必须仍有**按需**入口（`lib/editor/mathStyles.ts`），且编辑器挂载时会预热
//      —— 否则公式会以未样式化形态长期存在（不是"慢一点"，是"坏了"）；
//   ③ 启动打点（`lumin:*`）必须真的在关键节点上：入口执行 / 样式就位 / 首次装饰 / 编辑器绑定
//      —— 没有它们就再也量不出这类回归（本轮所有数字都出自这些 mark）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('入口 CSS 不许静态 @import KaTeX（渲染阻塞路径上不放公式样式）', () => {
  const style = read('src/renderer/src/assets/style.css')
  assert.doesNotMatch(
    style,
    /@import\s+['"]katex\/dist\/katex\.min\.css['"]/,
    'KaTeX 的 CSS 不许进入口：它会带 59 条 @font-face，把入口 CSS 从 ~111KB 抬到 ~143KB'
  )
  // 其它分片也不许偷偷把它 import 回来（只有 mathStyles.ts 那一处按需 import）
  for (const f of [
    'src/renderer/src/assets/theme.css',
    'src/renderer/src/assets/base.css',
    'src/renderer/src/assets/components.css',
    'src/renderer/src/assets/markdown.css',
    'src/renderer/src/assets/editor.css',
    'src/renderer/src/assets/overlays.css',
    'src/renderer/src/assets/chrome.css',
    'src/renderer/src/assets/sidebar.css'
  ]) {
    assert.doesNotMatch(read(f), /katex\/dist\/katex\.min\.css/, `${f} 不许引 KaTeX 的 CSS`)
  }
})

test('KaTeX 样式仍有按需入口，且编辑器挂载时会预热', () => {
  const lazy = read('src/renderer/src/lib/editor/mathStyles.ts')
  assert.match(
    lazy,
    /import\('katex\/dist\/katex\.min\.css'\)/,
    '必须走动态 import（Vite 会打成按需 CSS chunk）'
  )
  assert.match(lazy, /export function preloadKatexCss/)
  assert.match(lazy, /export function ensureKatexCss/)
  const view = read('src/renderer/src/views/EditorView.vue')
  assert.match(view, /import \{ preloadKatexCss \} from '\.\.\/lib\/editor\/mathStyles'/)
  // 必须在 setup 里就调（公式装饰是同步建的，放 onMounted 就晚了）
  const setupCall = view.indexOf('preloadKatexCss()')
  const mounted = view.indexOf('onMounted(() => {')
  assert.ok(
    setupCall > 0 && setupCall < mounted,
    'preloadKatexCss() 必须在 setup 里、onMounted 之前调用'
  )
  // 导出/打印那条链仍自带一份（独立文档要用），别被这轮改动顺手删掉
  const exp = read('src/renderer/src/lib/export.ts')
  assert.match(exp, /katex\/dist\/katex\.min\.css\?inline/, '导出用的 ?inline 那一份要留着')
})

/** 去掉注释（**只**用于"顺序"类断言：注释里会提到 `await router.isReady()` 之类的字样） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('「先挂载、再等路由」的顺序不许退回（它买来 ~76ms 的首屏）', () => {
  const main = stripComments(read('src/renderer/src/main.ts'))
  const mount = main.indexOf("app.mount('#app')")
  const ready = main.indexOf('await router.isReady()')
  assert.ok(mount > 0 && ready > 0, 'main.ts 里两件事都要在')
  assert.ok(
    mount < ready,
    '必须先 app.mount 让壳出帧、再 await router.isReady()：反过来的话那 ~76ms（EditorView 2.5MB chunk）里一帧都不画'
  )
  // 挂载与 await 之间必须有"真的出帧"这一步（nextTick 不够）
  const between = main.slice(mount, ready)
  assert.match(
    between,
    /requestAnimationFrame/,
    '挂载后要等一帧（rAF），否则省下的只是调用顺序而不是可见时间'
  )
})

test('启动打点覆盖关键节点（没有 mark 就量不出回归）', () => {
  const main = read('src/renderer/src/main.ts')
  for (const stage of ['entry-exec', 'css-ready', 'first-frame', 'fonts-ready', 'shell']) {
    assert.match(main, new RegExp(`mark\\('${stage}'\\)`), `main.ts 缺打点：${stage}`)
  }
  assert.match(
    read('src/renderer/src/lib/editor/markers.ts'),
    /lumin:decorations-first/,
    'markers.ts 缺首次装饰打点'
  )
  assert.match(
    read('src/renderer/src/stores/editor.ts'),
    /lumin:editor-bind/,
    'editor store 缺绑定打点'
  )
  const idx = read('src/main/index.ts')
  for (const label of ['db-ready', 'grants-ready']) {
    assert.match(idx, new RegExp(`startup\\('${label}'\\)`), `主进程缺阶段打点：${label}`)
  }
  // 打点一律**零阻塞**：这几个回调式打点不许被写成 await（写了就是"测带打点的启动"）
  assert.doesNotMatch(main, /await document\.fonts\.ready/, 'fonts-ready 打点不许 await')
})

test('启动探针在位（时间类判据的载体）', () => {
  const probe = read('tools/_probe-boot.js')
  // 多轮取中位数 + 冷/热分开 + 从磁盘量体积（页面 resource timing 在本应用恒为空）
  assert.match(probe, /--cold/)
  assert.match(probe, /--warm/)
  assert.match(probe, /function median/)
  assert.match(
    probe,
    /entryAssets\(\)/,
    '入口体积必须从构建产物量（resource timing 在本应用为空数组）'
  )
  assert.match(probe, /resTotal/, '把 resource timing 条数也记下来，便于发现"它其实为空"这件事')
  // 只杀自己的实例：不许到处 Stop-Process 别人的隔离实例/用户自己的 Lumin
  assert.match(probe, /lumin-boot-ud/)
  assert.doesNotMatch(probe, /CommandLine -like '\*lumin-\*'/, '别把所有 lumin 实例都杀掉')
})

test('构建必须开压缩（electron-vite 的默认是 minify: false —— 未压缩产物直接算进启动时间）', () => {
  const cfg = read('electron.vite.config.ts')
  // 三个目标都要显式开：renderer（入口 991→423KB）、main（334→220KB，在 app-ready 之前求值）、
  // preload。少一个就会又回到"读 991KB 源码"的启动路径。
  const minifyCount = [...cfg.matchAll(/minify:\s*'esbuild'/g)].length
  assert.ok(minifyCount >= 3, `main/preload/renderer 三处都要开压缩，实测只有 ${minifyCount} 处`)
  assert.doesNotMatch(cfg, /minify:\s*false/, '不许把它关回去')
  // 说明性注释要在（否则下一个人会以为是多余的）
  assert.match(
    cfg,
    /默认[\s\S]{0,60}minify|minify[\s\S]{0,60}默认/,
    '缺"electron-vite 默认不压缩、所以必须显式开"的注释'
  )
})
