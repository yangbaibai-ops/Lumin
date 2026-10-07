// 「拖动选中的文字去改位置」要不要拦 —— 判据单测（`src/renderer/src/lib/editor/dragRules.ts`）。
//
// 为什么值得单独钉住：**真实内部拖动在自动化里造不完整**（Chromium 的文本选区拖动靠原生
// 拖放循环，CDP 合成鼠标事件起不来那一步 demo 见 tools/_verify-no-text-drag.js 的如实边界），
// 而这条判据只有两个布尔输入、后果却是"文档会不会被搬走"。所以：
//   * 语义在**这里**穷举（4 种输入组合各一条）；
//   * 接线（PM 的 handleDrop 真的拿 moved / view.dragging.node 去问它）由那条 CDP 套件守。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksInternalTextDrag } from '../src/renderer/src/lib/editor/dragRules.ts'

test('文档内部拖动一段文字（moved，不是节点）→ 必须拦下', () => {
  assert.equal(blocksInternalTextDrag(true, false), true, 'ABCDEF 选中 DE 拖到 A|B 之间就是这一条')
})

test('从系统/别的程序拖入（moved=false）→ 放行（拖文件进窗口打开、拖文字进来都是它）', () => {
  assert.equal(blocksInternalTextDrag(false, false), false)
})

test('拖的是节点（图片/表格等 NodeView）→ 放行，节点拖动语义不在本轮范围内', () => {
  assert.equal(blocksInternalTextDrag(true, true), false)
})

test('既不是内部拖动、也不是文字 → 放行（Ctrl 拖动复制等 PM 原有语义）', () => {
  assert.equal(blocksInternalTextDrag(false, true), false)
})
