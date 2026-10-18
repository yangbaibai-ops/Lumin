// ─── 代码块语言 UI 的结构守则（去顶栏 / 聚焦浮层 / 自由输入 / 自动识别）────────────
//
// `tests/codeBlockLanguage.test.mjs` 钉的是纯逻辑；这里钉的是**组件与样式的结构**：
// 这几条如果被改回去，单测里的纯函数还是全绿，但用户会立刻看到「顶部又冒出一条语言栏」。
// 用源码断言（与 layoutNoOverflow / focusVisibility 同一套路）：
//   ① 未聚焦时 DOM/样式里不能再有常驻的语言条（顶栏 / 徽标 / select / 静态占位）；
//   ② 选择器必须是**聚焦才挂出来**的浮层（v-if），且定位是 fixed（脱离文档流、不被
//      `.code-block-wrapper` 的 overflow:hidden 裁掉、按视口夹住）—— 这是"块高不变"的结构前提；
//   ③ 位置必须在**代码块外面**（本轮用户需求）：由 placePicker 按块外壳 rect 算，默认上方、
//      顶部放不下翻下方；几何的"交集面积 = 0"由 tests/codeBlockLangPickerPlacement.test.mjs 钉；
//   ④ **没有"×"清空按钮**（本轮用户需求）：清空语言 = 手动把输入框内容删空；
//   ⑤ 无头浮层必须满足 combobox 语义（role / aria-expanded / aria-label）；
//   ⑥ 自由输入：应用语言时把**用户输入的原样字符串**写回 attrs；未内置语言只影响高亮
//      （loadLanguage 找不到 loader 时 reconfigure 成空扩展），不报错；
//   ⑦ 自动识别只在没有显式语言时跑，且**不**把识别结果写回 attrs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PICKER_GAP_PX,
  PICKER_MAX_WIDTH_RATIO
} from '../src/renderer/src/lib/editor/codeBlockLangPicker.ts'

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

test('浮层在代码块外面：按块外壳 rect + placePicker 定位（默认上方，放不下翻下方）', () => {
  assert.equal(PICKER_GAP_PX, 6, '浮层与块边缘的缝应保持 6px')
  assert.equal(PICKER_MAX_WIDTH_RATIO, 0.4, '宽度上限应为代码块宽的 40%')
  // 几何算法在纯函数模块里（tests/codeBlockLangPickerPlacement.test.mjs 证明交集 = 0）
  assert.match(
    script,
    /from '\.\.\/\.\.\/lib\/editor\/codeBlockLangPicker'/,
    'positionPicker 必须走 lib/editor/codeBlockLangPicker（几何纯函数）'
  )
  assert.doesNotMatch(script, /pickerAnchorEl/, '旧的"代码区右上角锚点"应已删除')
  const fn = script.slice(script.indexOf('function positionPicker'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /blockEl\(\)/, '必须以**代码块外壳**为锚点（不是代码区右上角）')
  assert.match(body, /getBoundingClientRect\(\)/, '必须量块外壳的视口 rect')
  assert.match(body, /placePicker\(\{/, '必须调用 placePicker 算"块外"坐标')
  // 只写四个"脱离文档流后才有意义"的 style：left/top/maxWidth/maxHeight。
  // 不写 width/height/margin ⇒ 浮层出现前后不参与布局（块高不变）。
  const styleAt = body.indexOf('pickerStyle.value = {')
  assert.ok(styleAt > 0, 'positionPicker 应写 pickerStyle')
  const styleBlock = body.slice(styleAt)
  for (const key of ['left', 'top', 'maxWidth', 'maxHeight']) {
    assert.match(styleBlock, new RegExp(`${key}:`), `positionPicker 应写 ${key}`)
  }
  assert.doesNotMatch(styleBlock, /(?:^|[^a-zA-Z])width:/, '浮层不许写布局宽度（只写 maxWidth）')
  assert.doesNotMatch(styleBlock, /(?:^|[^a-zA-Z])height:/, '浮层不许写布局高度（只写 maxHeight）')
  // 贴在哪一边写进 DOM，验收/调试能直接读
  assert.match(template, /:data-cb-picker-side="pickerSide/, '浮层应把贴边方向写进 data 属性')
})

test('块高出现前后一致（结构前提）：浮层 fixed + v-if，且不写布局尺寸', () => {
  const rule = css.match(/\.cb-lang-picker\s*\{[^}]*\}/)
  assert.ok(rule, '.cb-lang-picker 规则不见了')
  assert.match(rule[0], /position:\s*fixed/, 'fixed 是"块高不变"的结构前提（脱离文档流）')
  assert.match(rule[0], /width:\s*max-content/, '宽度必须由内容决定，不能写死一个会占位的宽度')
  assert.match(rule[0], /max-width:/, '宽度上限走 max-width（而不是 width）')
  assert.doesNotMatch(
    rule[0],
    /(?:^|[;{]\s*)height\s*:/,
    '不许给浮层写固定 height（高度由 max-height 按视口空间夹）'
  )
  assert.match(template, /v-if="pickerOpen"/, '浮层必须 v-if 挂出来（未聚焦时 DOM 里没有它）')
  // 外壳里没有为浮层预留的任何东西：它排在代码区之后，且不改变 wrapper 的内外距
  const wrapper = template.slice(template.indexOf('<node-view-wrapper'))
  const cmAt = wrapper.indexOf('class="cm-editor-container"')
  const pickerAt = wrapper.indexOf('class="cb-lang-picker"')
  assert.ok(cmAt > 0 && pickerAt > cmAt, '浮层应排在代码区之后')
})

test('没有"×"清空按钮：DOM / 逻辑 / 语言包都删干净，清空仍可手动删空', () => {
  assert.doesNotMatch(template, /cb-lang-clear/, '模板里不该再有清空按钮')
  assert.doesNotMatch(template, /data-cb-lang-clear/, '模板里不该再有清空按钮锚点')
  assert.doesNotMatch(script, /clearLanguage/, '不该再有一键清空逻辑')
  assert.doesNotMatch(script, /showClearButton/, '不该再有"清空按钮可见性"计算')
  for (const locale of ['zh-CN', 'en-US', 'ru-RU']) {
    assert.doesNotMatch(
      read(`src/shared/i18n/${locale}.json`),
      /codeLanguageClear/,
      `${locale} 里还留着没人用的清空语言文案`
    )
  }
  // 语义保留：输入为空 = 无语言（applyLanguageChoice 的空串分支仍在）
  const apply = script.slice(script.indexOf('function applyLanguageChoice'))
  const applyBody = apply.slice(0, apply.indexOf('\n}'))
  assert.match(
    applyBody,
    /detectSuppressed = name === ''/,
    '清空语义（空串 → 无语言 + 抑制识别）应保留'
  )
  // 没有"×"之后，"把输入框删空"就是清空路径：onPickerInput 必须把空串交给 applyLanguageChoice
  const inputFn = script.slice(script.indexOf('function onPickerInput'))
  const inputBody = inputFn.slice(0, inputFn.indexOf('\n}'))
  assert.match(inputBody, /next\.trim\(\) === ''/, '删空输入框必须被识别为"无语言"')
  assert.match(inputBody, /applyLanguageChoice\(''\)/, '删空输入框必须写回空语言（不是选 text）')
  // 输入框仍可自由输入（没有 readonly/disabled，input 事件仍在）
  const row = template.slice(template.indexOf('class="cb-lang-row"'))
  const input = row.slice(0, row.indexOf('</div>'))
  assert.doesNotMatch(input, /readonly|disabled/, '输入框不该被锁成只读')
  assert.match(input, /@input="onPickerInput"/, '输入框必须还能自由输入/删空')
})

test('键位口径不回归：聚焦出现、失焦隐藏、Esc / Tab / Enter / 方向键', () => {
  // 触发：focusin 打开、focusout 收起（与旧口径一致）
  assert.match(script, /addEventListener\('focusin', onBlockFocusIn\)/, '聚焦必须仍能打开浮层')
  assert.match(script, /addEventListener\('focusout', onBlockFocusOut\)/, '失焦必须仍能收起浮层')
  const fn = script.slice(script.indexOf('function onPickerKeydown'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /e\.key === 'Escape'[\s\S]{0,120}closePicker\(\)[\s\S]{0,80}focusCodeArea\(\)/)
  assert.match(body, /e\.key === 'Tab'\) return/, 'Tab 必须放行给浏览器（焦点离开即收起）')
  assert.match(body, /ArrowDown[\s\S]{0,40}ArrowUp/, '方向键必须能移动选中项')
  assert.match(body, /e\.key === 'Enter'/, 'Enter 必须能展开列表/应用语言')
  assert.match(script, /function openList\(\)/, '缺 openList（Enter/方向键展开列表的落点）')
  // 自动识别后（无显式语言）打开时预填识别结果
  assert.match(
    script,
    /pickerQuery\.value = selectedLanguage\.value === PLAIN_TEXT_LANGUAGE \? '' : selectedLanguage\.value/,
    '打开浮层时应预填当前（含自动识别出的）语言'
  )
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
