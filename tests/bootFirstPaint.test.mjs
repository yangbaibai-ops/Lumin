// ─── 启动首帧：纸色 + 内联骨架（#boot-splash）─────────────────────────────────
//
// 历史（两轮相反的用户口径，别搞混）：
//   1. 早先 index.html 里有一段「假顶栏 + 假侧栏 + 假正文」的整窗骨架，用户说不要过场 ⇒ 删除；
//   2. 删除后暴露了真问题：窗口在渲染层首帧之前就 show()，browser 默认画布是**白色**，
//      机器慢时就是「打开后白屏 5–6s」。用户这一轮的口径很明确：**白屏不可接受**，
//      一打开就要看到品牌/骨架。
//
// 所以现在的骨架不是"过场动画"，而是**首帧的兜底画面**：纯 HTML + 内联 CSS，不依赖 JS bundle，
// 只有一个居中的图标 + 应用名 + 细进度条，Vue 首帧后 200ms 淡出。这个文件守的就是它：
//   * 必须在 body 最前面、在任何 <script> 之前（否则 JS 慢时又变白屏）；
//   * 背景必须是主题纸色（--paper），**不是纯白**；
//   * 不进无障碍树、不拦截焦点/点击；
//   * 移除只走 200ms opacity，且 1500ms 有强制兜底（见 bootSplash.test.mjs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { APP_ICON_PNG_BASE64 } from '../src/renderer/src/assets/iconPng.ts'
import { PAPER_BY_THEME } from '../src/shared/theme.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8')
const MAIN = readFileSync(join(ROOT, 'src/renderer/src/main.ts'), 'utf8')
const MAIN_PROCESS = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')

test('启动骨架在 body 最前面、位于任何 <script> 之前（JS 慢也先看到东西）', () => {
  const body = HTML.indexOf('<body>')
  const splash = HTML.indexOf('id="boot-splash"')
  const app = HTML.indexOf('<div id="app"></div>')
  const script = HTML.indexOf('<script type="module"')
  assert.ok(body > 0 && splash > body, 'index.html 的 <body> 里必须有 #boot-splash')
  assert.ok(app > splash, '#app 必须在骨架之后（骨架是盖在它上面的一层）')
  assert.ok(script > splash && script > app, '入口 <script> 必须在骨架与 #app 之后')
  // 骨架块里不许有脚本 / 内联事件（CSP 也不允许内联脚本）
  const between = HTML.slice(splash, app)
  assert.equal(/<script|on[a-z]+\s*=/i.test(between), false, '骨架里不许出现脚本或内联事件')
})

test('骨架可访问性：aria-hidden + 不拦截焦点/点击 + 动效只用 transform/opacity', () => {
  assert.match(HTML, /id="boot-splash"\s+aria-hidden="true"/, '骨架必须 aria-hidden="true"')
  const splashCss = HTML.slice(
    HTML.indexOf('#boot-splash {'),
    HTML.indexOf('@keyframes boot-slide')
  )
  assert.match(
    splashCss,
    /pointer-events:\s*none/,
    '骨架必须 pointer-events:none（不拦截点击/焦点）'
  )
  assert.match(splashCss, /transition:\s*opacity\s+200ms/, '移除必须走 200ms opacity 过渡')
  assert.match(splashCss, /transform:\s*translate3d/, '进度条动效必须用 transform')
  assert.doesNotMatch(
    HTML,
    /@keyframes[^{]*\{[^}]*\b(left|top|width|height|margin)\s*:/,
    '启动骨架的 keyframes 不许改布局属性（只允许 transform/opacity）'
  )
})

test('骨架背景 = 主题纸色（--boot-paper），且不是纯白', () => {
  assert.match(
    HTML,
    new RegExp(`--boot-paper:\\s*${PAPER_BY_THEME.light}`, 'i'),
    `index.html 的 --boot-paper 必须等于 PAPER_BY_THEME.light（${PAPER_BY_THEME.light}）`
  )
  assert.notEqual(PAPER_BY_THEME.light.toLowerCase(), '#ffffff', '浅色纸不许是纯白（会白屏）')
  assert.match(
    HTML,
    /html,\s*body\s*\{[^}]*background:\s*var\(--boot-paper\)/,
    '首帧画布必须铺纸色'
  )
  assert.match(
    HTML,
    /#boot-splash\s*\{[^}]*background:\s*var\(--boot-paper\)/,
    '骨架自身必须铺纸色'
  )
  // 纯白在任何启动路径上都不许出现（注释里可以提到历史）
  const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'))
  assert.doesNotMatch(style, /#fff(?:fff)?\b/i, '启动内联样式里不许出现纯白')
})

test('骨架图标是 resources/icon.png 的 128×128 内嵌位图（与 iconPng.ts 同步）', () => {
  const m = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(HTML)
  assert.ok(m, '骨架里找不到内嵌图标 data URI')
  assert.equal(
    m[1],
    APP_ICON_PNG_BASE64,
    'index.html 的启动图标与 iconPng.ts 不同步：跑 node tools/sync-app-icon.js'
  )
  const buf = Buffer.from(m[1], 'base64')
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '启动图标不是 PNG')
  assert.equal(buf.readUInt32BE(16), 128, '启动图标应为 128×128（1024 档太大）')
  assert.equal(buf.readUInt32BE(20), 128)
  assert.ok(
    HTML.indexOf('<div class="boot-name">Lumin</div>') > HTML.indexOf('id="boot-splash"'),
    '骨架要显示应用名'
  )
  assert.match(HTML, /class="boot-track"><span class="boot-bar"><\/span>/, '骨架要有细进度条')
})

test('窗口显示时机：show:false + ready-to-show 或 600ms 兜底，backgroundColor 走主题纸色', () => {
  assert.match(MAIN_PROCESS, /show:\s*false/, '窗口必须先隐藏，避免白闪')
  assert.match(
    MAIN_PROCESS,
    /backgroundColor:\s*[\s\S]{0,220}paperForTheme\(/,
    'backgroundColor 必须由 paperForTheme 算出（与 --paper 同源）'
  )
  assert.match(
    MAIN_PROCESS,
    /mainWindow\.on\('ready-to-show',\s*\(\)\s*=>\s*reveal\('ready-to-show'\)\)/,
    'ready-to-show 时必须显示窗口'
  )
  assert.match(
    MAIN_PROCESS,
    /earlyShowMs:\s*600/,
    '首窗必须有 600ms 兜底显示（慢盘上不能一直不出现；正常机器走 ready-to-show）'
  )
  assert.match(
    MAIN_PROCESS,
    /setTimeout\(\(\)\s*=>\s*reveal\('timeout'\),\s*earlyShowMs\)/,
    '兜底定时器不见了'
  )
})

test('渲染层顺序：先 arm 兜底 → 慢渲染延迟 → 挂载 → dismiss 骨架', () => {
  const arm = MAIN.indexOf('armBootSplashDeadline(BOOT_DELAY_MS)')
  const bootstrap = MAIN.indexOf('async function bootstrap')
  const delay = MAIN.indexOf('setTimeout(resolve, BOOT_DELAY_MS)')
  const settings = MAIN.indexOf('await settings.init()')
  const mount = MAIN.indexOf("app.mount('#app')")
  const dismiss = MAIN.indexOf('dismissBootSplash()')
  // 注释里也出现过 `await router.isReady()`（说明「先挂载、再等路由」的历史），只认挂载之后那处
  const router = MAIN.indexOf('await router.isReady()', mount)
  assert.ok(arm > 0 && arm < bootstrap, '兜底必须在模块求值期就装上（早于 bootstrap）')
  assert.ok(delay > bootstrap && delay < settings, '人为慢渲染延迟必须在 settings.init 之前')
  assert.ok(mount > 0 && dismiss > mount, '骨架必须在 Vue 挂载之后才撤')
  assert.ok(dismiss < router, '骨架在壳出帧后就撤，不该等 EditorView 大 chunk')
})
