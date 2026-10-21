// ─── 启动骨架的移除与兜底（#boot-splash）────────────────────────────────────────
//
// 为什么单独一条：骨架本身是 index.html 的静态内容（bootFirstPaint.test.mjs 守），
// 但**什么时候撤**是行为，错了的后果分别是：
//   * 撤早了 ⇒ 半成品界面/白纸（慢机器上比白屏更糟）；
//   * 撤晚了/不撤 ⇒ 骨架永远挡住界面（bootstrap 抛错时）。
// 这里用纯函数 + 静态结构钉住两端：
//   默认 1500ms 强制移除；人为慢渲染（LUMIN_BOOT_DELAY_MS）时上限同步 + delay；
//   正常路径在 fonts.ready + 双 rAF 之后才淡出，且只改 opacity、不动布局。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BOOT_SPLASH_FADE_MS,
  BOOT_SPLASH_ID,
  BOOT_SPLASH_MAX_WAIT_MS,
  bootSplashDeadline
} from '../src/renderer/src/lib/bootSplash.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const BOOT = read('src/renderer/src/lib/bootSplash.ts')
const MAIN = read('src/renderer/src/main.ts')
const PRELOAD = read('src/preload/index.ts')
const MAIN_PROCESS = read('src/main/index.ts')
const HTML = read('src/renderer/index.html')

test('骨架 node id / 淡出时长与 index.html 一致', () => {
  assert.equal(BOOT_SPLASH_ID, 'boot-splash')
  assert.equal(BOOT_SPLASH_FADE_MS, 200)
  assert.match(HTML, /transition:\s*opacity\s+200ms/, 'index.html 的淡出时长与常量不一致')
  assert.match(HTML, /data-state='hidden'|data-state="hidden"/, 'index.html 必须定义淡出态')
})

test('兜底超时：默认 1500ms，慢渲染模式把延迟叠加进去', () => {
  assert.equal(BOOT_SPLASH_MAX_WAIT_MS, 1500)
  assert.equal(bootSplashDeadline(0), 1500)
  assert.equal(bootSplashDeadline(), 1500)
  assert.equal(bootSplashDeadline(3000), 4500, 'LUMIN_BOOT_DELAY_MS=3000 时上限必须是 4500ms')
  // 配置写错（负数 / NaN / Infinity）不许把上限变成 0（那等于立刻撤骨架）
  assert.equal(bootSplashDeadline(-5), 1500)
  assert.equal(bootSplashDeadline(Number.NaN), 1500)
  assert.equal(bootSplashDeadline(Number.POSITIVE_INFINITY), 1500)
  assert.equal(bootSplashDeadline(12.9), 1512)
})

test('首帧判定：fonts.ready + 双 rAF，之后加 hidden 并移除节点', () => {
  assert.match(BOOT, /document\.fonts/, '必须等 document.fonts.ready')
  assert.match(BOOT, /\.then\(drawFrame,\s*drawFrame\)/, '字体加载失败也必须继续撤骨架（两个分支）')
  assert.match(
    BOOT,
    /requestAnimationFrame\(\(\)\s*=>\s*requestAnimationFrame\(/,
    '必须双 rAF（单 rAF 在慢机器上会早一帧）'
  )
  assert.match(BOOT, /el\.dataset\.state = 'hidden'/, '先加 hidden 触发 200ms 过渡')
  assert.match(BOOT, /el\.remove\(\)/, '过渡结束后必须移除节点')
  // 幂等：兜底定时器与正常路径可能同时到
  assert.match(BOOT, /if \(el\.dataset\.state === 'hidden'\) return/, '重复调用必须幂等')
})

test('兜底在入口模块求值期装上，且挡在 bootstrap 任何 await 之前', () => {
  const arm = MAIN.indexOf('armBootSplashDeadline(BOOT_DELAY_MS)')
  const bootstrap = MAIN.indexOf('async function bootstrap')
  assert.ok(arm > 0 && arm < bootstrap, 'armBootSplashDeadline 必须在模块顶层、bootstrap 定义之前')
  assert.doesNotMatch(
    MAIN.slice(0, arm),
    /await\s/,
    'arm 之前不许有 await（否则 JS 卡住时兜底还没装上）'
  )
})

/**
 * 双层兜底：
 *   * JS 跑起来了 → bootSplash.ts 的计时器（1500ms + 人为延迟）；
 *   * JS 根本没跑起来（bundle 解析失败/被拦）→ index.html 里那条纯 CSS 的 1500ms 兜底。
 * 两者必须由 `html[data-boot-js='1']` 交接：JS 一接管就取消 CSS 那条，否则 3s 慢渲染
 * 验收时 CSS 会在 1.5s 把骨架藏掉，看起来像"兜底提前生效"。
 */
test('纯 CSS 兜底 + JS 接管后的交接（慢渲染时不许让 CSS 提前藏骨架）', () => {
  assert.match(
    HTML,
    /@keyframes\s+boot-failsafe/,
    'index.html 缺纯 CSS 兜底（JS 完全没跑起来时骨架会永远挡住）'
  )
  assert.match(HTML, /animation:\s*boot-failsafe[^;]*1500ms/, 'CSS 兜底必须是首帧起 1500ms')
  assert.match(
    HTML,
    /html\[data-boot-js='1'\]\s+#boot-splash\s*\{[^}]*animation:\s*none/,
    'JS 接管后必须取消 CSS 兜底'
  )
  assert.match(MAIN, /dataset\.bootJs\s*=\s*'1'/, 'main.ts 必须写 html[data-boot-js=1]')
  const mark = MAIN.indexOf("dataset.bootJs = '1'")
  const arm = MAIN.indexOf('armBootSplashDeadline(BOOT_DELAY_MS)')
  assert.ok(mark > 0 && arm > mark, '先取消 CSS 兜底、再装 JS 兜底（顺序反了会有一瞬间双计时）')
})

test('人为慢渲染开关：主进程读 LUMIN_BOOT_DELAY_MS → argv → preload → 渲染层', () => {
  assert.match(MAIN_PROCESS, /LUMIN_BOOT_DELAY_MS/, '主进程必须读这个环境变量')
  assert.match(MAIN_PROCESS, /--lumin-boot-delay-ms=/, '必须经 additionalArguments 传下去')
  assert.match(PRELOAD, /--lumin-boot-delay-ms=/, 'preload 必须解析这个参数')
  assert.match(PRELOAD, /bootDelayMs,/, 'preload 必须暴露 bootDelayMs')
  assert.match(MAIN, /window\.luminAPI\.app\.bootDelayMs/, '渲染层必须读 bootDelayMs')
  assert.match(MAIN, /setTimeout\(resolve, BOOT_DELAY_MS\)/, '慢渲染延迟必须真的 await')
  // 产品默认：环境变量不设就是 0，且上限 30s
  assert.match(
    MAIN_PROCESS,
    /Math\.min\(Math\.floor\(raw\), 30000\)/,
    '必须钳制上限（误配不许拖死窗口）'
  )
})
