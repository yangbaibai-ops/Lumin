// 拖拽全禁用（drag & drop）—— 入口拦截 + DOM/样式不变量单测。
//
// 真实浏览器里的验收（幽灵图、dropcursor 计数、真鼠标手势、CDP 文件投递）在
// `tools/_verify-dnd-disabled.js`；这里钉住的是三条最容易被"顺手改回去"的接线：
//   * window 捕获阶段的 drag* 拦截（且绝不碰鼠标事件 —— 拖选必须还在）；
//   * DOM 侧 `draggable=false` / 全局 `-webkit-user-drag: none`；
//   * 扩展集与 CSS 里不再有 dropcursor / 拖拽落点 / 拖拽光标。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DRAG_EVENTS, installDragGuard } from '../src/renderer/src/lib/dragGuard.ts'

const ROOT = join(import.meta.dirname, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf-8')

/** 最小 DataTransfer 桩（Node 里没有 DragEvent）：只关心两个可写属性 */
function fakeEvent(type, dt) {
  const e = new Event(type, { cancelable: true, bubbles: true })
  if (dt) Object.defineProperty(e, 'dataTransfer', { value: dt })
  return e
}

test('dragstart 在入口被 preventDefault + stopPropagation，幽灵图起不来', () => {
  const target = new EventTarget()
  const off = installDragGuard(target)
  const dt = { effectAllowed: 'all', dropEffect: 'copy' }
  const e = fakeEvent('dragstart', dt)
  // dispatchEvent 返回 false = 事件被 preventDefault（否则浏览器会开始原生拖拽）
  assert.equal(target.dispatchEvent(e), false)
  assert.equal(e.defaultPrevented, true, 'dragstart 必须 preventDefault')
  assert.equal(dt.effectAllowed, 'none', 'dragstart 必须封掉 effectAllowed')
  assert.equal(dt.dropEffect, 'none', 'dragstart 必须封掉 dropEffect')
  off()
  assert.equal(
    target.dispatchEvent(fakeEvent('dragstart')),
    true,
    '卸载后不再拦（热更新/单测隔离）'
  )
})

test('dragover / drop 同样被拦：文件拖入既不插入也不打开', () => {
  const target = new EventTarget()
  const off = installDragGuard(target)
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drag', 'drop', 'dragend']) {
    const dt = { effectAllowed: 'all', dropEffect: 'copy' }
    const e = fakeEvent(type, dt)
    assert.equal(target.dispatchEvent(e), false, `${type} 必须被 preventDefault`)
    assert.equal(e.defaultPrevented, true, `${type} 必须 preventDefault`)
    assert.equal(dt.dropEffect, 'none', `${type} 的放置光标必须是禁止态`)
  }
  off()
})

test('拦截器只注册 drag*，绝不碰 mousedown/mousemove/mouseup（拖选保留）', () => {
  const registered = []
  installDragGuard({
    addEventListener: (type) => registered.push(type),
    removeEventListener: () => {}
  })
  assert.deepEqual(registered, [...DRAG_EVENTS], '注册的事件必须与 DRAG_EVENTS 完全一致')
  const allowed = new Set(DRAG_EVENTS)
  for (const type of registered) {
    assert.ok(allowed.has(type), `只许拦截 drag&drop 事件，实际注册了 ${type}`)
    assert.doesNotMatch(type, /mouse|pointer|click|key|paste/i, `${type} 不属于拖拽事件`)
  }
  const guard = read('src/renderer/src/lib/dragGuard.ts')
  assert.doesNotMatch(
    guard,
    /addEventListener\(\s*['"](mousedown|mousemove|mouseup|pointerdown)/,
    '拖选依赖鼠标事件；拦截器一旦监听它们，拖选就会坏'
  )
})

test('DOM 侧：树行 draggable=false，图片节点 schema 不可拖', () => {
  assert.match(
    read('src/renderer/src/components/TreeNode.vue'),
    /draggable="false"/,
    '文件树行必须显式 draggable="false"'
  )
  assert.match(
    read('src/renderer/src/lib/editor/extensions.ts'),
    /draggable:\s*false/,
    'Image 节点必须从 schema 层 draggable:false'
  )
  assert.match(
    read('src/renderer/src/lib/dragGuard.ts'),
    /el\.draggable = false/,
    'DOM 纠偏必须把天然拖拽源（img/a/选中节点）钉成 draggable=false'
  )
})

test('样式侧：全局 -webkit-user-drag:none，且没有 dropcursor / 拖拽光标 / !important', () => {
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
  assert.doesNotMatch(
    css,
    /\.is-drop-target|\.is-dragging|\[data-dragging\]/,
    '拖拽高亮/动效样式必须不存在'
  )
  assert.doesNotMatch(
    read('src/renderer/src/lib/editor/extensions.ts'),
    /dropCursor/,
    '扩展集里不许有 dropCursor'
  )
})
