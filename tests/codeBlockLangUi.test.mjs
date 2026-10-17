// ─── 代码块语言 UI 的结构守则（去顶栏 / 聚焦浮层 / 自由输入 / 自动识别）────────────
//
// `tests/codeBlockLanguage.test.mjs` 钉的是纯逻辑；这里钉的是**组件与样式的结构**：
// 这几条如果被改回去，单测里的纯函数还是全绿，但用户会立刻看到「顶部又冒出一条语言栏」。
// 用源码断言（与 layoutNoOverflow / focusVisibility 同一套路）：
//   ① 未聚焦时 DOM/样式里不能再有常驻的语言条（顶栏 / 徽标 / select / 静态占位）；
//   ② 选择器必须是**聚焦才挂出来**的浮层（v-if），且定位是 fixed（脱离文档流、不被
//      `.code-block-wrapper` 的 overflow:hidden 裁掉、按视口夹住）—— 这是"块高不变"的结构前提；
//   ③ 无头浮层必须满足 combobox 语义（role / aria-expanded / aria-label）；
//   ④ 自由输入：应用语言时把**用户输入的原样字符串**写回 attrs；未内置语言只影响高亮
//      （loadLanguage 找不到 loader 时 reconfigure 成空扩展），不报错；
//   ⑤ 自动识别只在没有显式语言时跑，且**不**把识别结果写回 attrs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const vue = read('src/renderer/src/components/editor/CodeBlockView.vue')
const css = read('src/renderer/src/assets/overlays.css')
const lang = read('src/renderer/src/lib/editor/codeBlockLanguage.ts')

/** 去掉 HTML 注释：注释里会写"这里原先是 code-block-header"，不能当实现 */
const template = vue.slice(vue.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')
/** 去掉 JS/TS 注释（结构断言只看代码；说明文字里出现旧名字是正常的） */
const script = vue
  .slice(vue.indexOf('<script setup'), vue.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('去顶栏：模板里没有语言条 / 徽标 / select / 静态占位', () => {
  assert.doesNotMatch(template, /code-block-header/, '常驻顶栏又回来了')
  assert.doesNotMatch(template, /code-block-lang-label/, '语言徽标又回来了')
  assert.doesNotMatch(template, /code-block-select/, '语言下拉/占位又回来了')
  assert.doesNotMatch(template, /data-cb-header/, '顶栏锚点还在')
  // 外壳第一层子节点只能是三种代码形态之一（mermaid / 静态 pre / CM），不能先渲染一条栏
  const wrapper = template.slice(template.indexOf('<node-view-wrapper'))
  const firstChild = wrapper.search(/<(div|pre)\b/)
  assert.ok(firstChild > 0, '找不到 node-view-wrapper 的子节点')
  assert.doesNotMatch(
    wrapper.slice(firstChild, firstChild + 120),
    /header|lang-label/,
    '外壳的第一个子节点变成了什么"头"？'
  )
})

test('CSS：顶栏那套规则已删除；外壳仍 overflow:hidden（layoutNoOverflow 的前提）', () => {
  assert.doesNotMatch(css, /\.code-block-header\s*\{/, '顶栏样式还在')
  assert.doesNotMatch(css, /\.code-block-lang-label\s*\{/, '语言徽标样式还在')
  assert.doesNotMatch(css, /\.code-block-select\s*\{/, '语言下拉样式还在')
  assert.match(
    css,
    /\.code-block-wrapper\s*\{[^}]*overflow:\s*hidden/,
    '外壳必须继续裁住内部滚动条（layoutNoOverflow 守着这条）'
  )
})

test('选择器是聚焦才挂出来的浮层：v-if + fixed + 视口上限', () => {
  // v-if（不是 v-show / 常驻）：未聚焦时 DOM 里没有这个节点
  assert.match(template, /v-if="pickerOpen"/, '浮层不是 v-if=pickerOpen 了（会常驻或占位）')
  assert.doesNotMatch(
    template,
    /v-show="pickerOpen"/,
    '不要退回 v-show：那会留下一个不可见的常驻节点'
  )
  // DOM 顺序：浮层在代码区之后（Tab 从 CM 正好落到它）
  const cmAt = template.indexOf('class="cm-editor-container"')
  const pickerAt = template.indexOf('class="cb-lang-picker"')
  assert.ok(cmAt > 0 && pickerAt > cmAt, '浮层必须渲染在代码区之后（Tab 顺序）')

  const rule = css.match(/\.cb-lang-picker\s*\{[^}]*\}/)
  assert.ok(rule, '.cb-lang-picker 规则不见了')
  assert.match(
    rule[0],
    /position:\s*fixed/,
    '浮层必须脱离文档流（block 里 overflow:hidden，absolute 会被裁）'
  )
  assert.match(rule[0], /max-width:\s*min\([^)]*100vw/, '缺窄窗口兜底：浮层会撑出视口')
  assert.match(rule[0], /min-width:\s*0/, '缺 min-width:0：长语言名会把浮层撑宽')
  assert.match(rule[0], /z-index:\s*var\(--z-popover\)/, '浮层层级要走令牌')
  // 不占布局：浮层没有任何静态定位属性（left/top 由 JS 按视口算）
  assert.match(script, /pickerStyle\.value\s*=\s*\{\s*left:/, '浮层位置应由 positionPicker 计算')
})

test('无障碍：combobox 语义成对出现', () => {
  const picker = template.slice(template.indexOf('class="cb-lang-picker"'))
  const block = picker.slice(0, picker.indexOf('</div>\n  </node-view-wrapper>'))
  assert.match(block, /role="combobox"/, '输入框缺 role=combobox')
  assert.match(block, /:aria-expanded="listOpen/, '缺 aria-expanded（读屏器不知道列表开没开）')
  assert.match(block, /:aria-label="\$t\('editor\.codeLanguage'\)"/, '输入框缺 aria-label')
  assert.match(block, /role="listbox"/, '候选列表缺 role=listbox')
  assert.match(block, /role="option"/, '候选项缺 role=option')
  assert.match(block, /aria-activedescendant/, '方向键选择需要 aria-activedescendant')
  // Esc 关闭且把焦点还给代码区
  assert.match(script, /function focusCodeArea\(\)/, '缺"把焦点还给代码区"的实现')
  assert.match(
    script,
    /e\.key === 'Escape'[\s\S]{0,200}closePicker\(\)[\s\S]{0,80}focusCodeArea\(\)/
  )
})

test('自由输入：写回的是用户输入的原样名字，不是高亮键', () => {
  // 归一化只 trim，不做别名替换
  assert.match(lang, /return typeof raw === 'string' \? raw\.trim\(\) : ''/)
  const fn = script.slice(script.indexOf('function applyLanguageChoice'))
  assert.match(fn, /const name = normalizeLanguageName\(raw\)/, '应用语言前必须归一化用户输入')
  assert.match(
    fn,
    /props\.updateAttributes\(\{ language: name \}\)/,
    '必须把原样语言名写进 language 属性'
  )
  // 未内置语言：loadLanguage 找不到 loader → reconfigure 成空扩展（纯文本），不抛
  const load = script.slice(script.indexOf('async function loadLanguage'))
  assert.match(
    load,
    /if \(!loader\) \{[\s\S]{0,200}languageCompartment\.reconfigure\(\[\]\)/,
    '未内置语言必须落回纯文本（reconfigure 空扩展），而不是报错/静默停摆'
  )
  // 清空 = 写空串（裸围栏），并且本次会话不再自动识别回来
  assert.match(script, /detectSuppressed = name === ''/, '清空后必须抑制自动识别')
})

test('自动识别：只在没有显式语言时跑，且不写回文档', () => {
  const fn = script.slice(script.indexOf('function scheduleDetect'))
  assert.match(
    fn,
    /if \(explicitLanguage\.value \|\| detectSuppressed\) return/,
    '有显式语言/用户清空时不能再跑识别（否则会覆盖用户的选择）'
  )
  assert.match(fn, /DETECT_DEBOUNCE_MS/, '识别必须防抖（不能每键一次）')
  const run = script.slice(script.indexOf('function runDetect'))
  const runBody = run.slice(0, run.indexOf('\n}'))
  assert.doesNotMatch(runBody, /updateAttributes/, '自动识别绝不能写回 language 属性')
  assert.match(runBody, /detectedLanguage\.value = next/, '识别结果应只落在 detectedLanguage')
  // 生效语言变化时不应再写 attrs（原实现就是这么污染文档的）
  const watchAt = script.indexOf('watch(selectedLanguage')
  assert.ok(watchAt >= 0, '找不到 watch(selectedLanguage)')
  const watchBlock = (script.slice(watchAt).match(/^watch\(selectedLanguage[\s\S]*?\n\}\)/m) || [
    ''
  ])[0]
  assert.ok(
    watchBlock.length > 100,
    `没截到 watch(selectedLanguage) 的完整调用：${watchBlock.length}`
  )
  assert.doesNotMatch(
    watchBlock,
    /updateAttributes/,
    'watch(selectedLanguage) 里不该再 updateAttributes（自动识别的值会变成"显式设置"）'
  )
})

test('不硬编码颜色、不用 !important（本轮新增样式）', () => {
  assert.doesNotMatch(css, /!important/, '不许用 !important')
  const pickerCss = css.slice(
    css.indexOf('.cb-lang-picker'),
    css.indexOf('.cm-editor-container .cm-editor')
  )
  assert.ok(pickerCss.length > 400, '没截到浮层样式段')
  assert.doesNotMatch(pickerCss, /#[0-9a-f]{3,8}\b/i, '浮层样式里出现了硬编码 hex 颜色')
  assert.doesNotMatch(pickerCss, /\b(?:rgba?|hsla?)\(/i, '浮层样式里出现了硬编码 rgb/hsl 颜色')
})
