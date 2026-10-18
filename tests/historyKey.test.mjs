// ─── 全局撤销：mermaid 提交与「焦点在块外」的 Ctrl+Z ──────────────────────────
//
// 用户报障：「编辑完 mermaid 的代码后，把焦点放在其他地方（mermaid 代码块隐藏），
// 再按 Ctrl+Z 无法撤销刚才对 mermaid 的修改。」
//
// 实测结论（真键盘/CDP，报告见提交信息）：
//   * 是 (B) 按键没到编辑器，**不是** (A) 事务没进历史：
//     `commitMermaid()` 的写回事务 `tr.getMeta('addToHistory') === undefined`、
//     `editor.commands.undo()` 一条命令就能把源码逐字还原；
//     但点状态栏 / 正文下方留白后 `document.activeElement === <body>`，
//     PM 的 keymap 挂在编辑器 DOM 上，收不到按键。
//   * 修法：`views/EditorView.vue` 在 window 捕获阶段补一个**投递**——
//     焦点不在任何编辑面里时，把 Ctrl/Cmd+Z 交给主编辑器既有的 `undo()/redo()`。
//     不新建历史、不抢嵌套编辑器（它们有自己的本地历史）。
//
// 这里钉住两件事：① 判定的纯函数；② 源码接线（提交事务仍是普通历史事务、
// 全局兜底确实复用同一个命令、编辑面/模态层/源码模式的边界没有被越过去）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

installTsExtensionResolve()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const { historyIntent, isNestedEditorTarget } =
  await import('../src/renderer/src/lib/editor/historyKey.ts')

const editorView = read('src/renderer/src/views/EditorView.vue')
const codeBlockView = read('src/renderer/src/components/editor/CodeBlockView.vue')

const viewScript = editorView
  .slice(editorView.indexOf('<script setup'), editorView.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const cbScript = codeBlockView
  .slice(codeBlockView.indexOf('<script setup'), codeBlockView.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

function fnBody(script, startMarker, endMarker) {
  const start = script.indexOf(startMarker)
  assert.ok(start >= 0, `找不到 ${startMarker}`)
  const end = endMarker ? script.indexOf(endMarker, start) : script.length
  assert.ok(end > start, `找不到 ${endMarker}`)
  return script.slice(start, end)
}

// ─── ① 按键归属（纯函数）─────────────────────────────────────────────────────
test('撤销组合：Ctrl/Cmd+Z 撤销、+Shift 或 Ctrl+Y 重做，Alt/组字都不接', () => {
  const base = { key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
  assert.equal(historyIntent(base), 'undo')
  assert.equal(historyIntent({ ...base, key: 'Z', shiftKey: true }), 'redo', 'Shift 下 e.key 是 Z')
  assert.equal(historyIntent({ ...base, key: 'y' }), 'redo', 'Ctrl+Y = 重做（Windows 习惯）')
  assert.equal(historyIntent({ ...base, metaKey: true, ctrlKey: false }), 'undo', 'macOS Cmd+Z')
  assert.equal(historyIntent({ ...base, altKey: true }), null, 'Alt 组合让行')
  assert.equal(historyIntent({ ...base, ctrlKey: false }), null, '没有修饰键不是全局撤销')
  assert.equal(historyIntent({ ...base, isComposing: true }), null, 'IME 组字不接')
  assert.equal(historyIntent({ ...base, key: 'x' }), null)
})

test('编辑面判定：textarea/input/contenteditable 与 PM/CM/源码编辑器都是「别人的地盘」', () => {
  const inSurface = (sel) => ({
    tagName: 'DIV',
    closest: (q) => (q.includes(sel) ? { tagName: 'DIV' } : null)
  })
  assert.equal(isNestedEditorTarget({ tagName: 'TEXTAREA', closest: () => null }), true)
  assert.equal(isNestedEditorTarget({ tagName: 'INPUT', closest: () => null }), true)
  assert.equal(isNestedEditorTarget({ tagName: 'SELECT', closest: () => null }), true)
  assert.equal(
    isNestedEditorTarget({ tagName: 'DIV', isContentEditable: true }),
    true,
    'CM 的 contenteditable'
  )
  assert.equal(
    isNestedEditorTarget(inSurface('.ProseMirror')),
    true,
    '正文由 PM 自己的 keymap 处理'
  )
  assert.equal(isNestedEditorTarget(inSurface('.cm-editor')), true)
  assert.equal(isNestedEditorTarget(inSurface('.source-editor')), true, '源码模式 textarea')
  assert.equal(
    isNestedEditorTarget({ tagName: 'BODY', closest: () => null }),
    false,
    'body = 全局兜底要接'
  )
  assert.equal(isNestedEditorTarget({ tagName: 'BUTTON', closest: () => null }), false)
  assert.equal(isNestedEditorTarget(null), false)
})

// ─── ② mermaid 提交进历史（(A) 的反证）───────────────────────────────────────
test('mermaid 提交进历史：写回是一次普通事务，不许标 addToHistory:false', () => {
  const commit = fnBody(cbScript, 'function commitMermaid')
  assert.match(
    commit,
    /props\.editor\.commands\.command\(\(\{ tr \}\) => \{/,
    '写回必须走主编辑器命令'
  )
  assert.doesNotMatch(
    commit,
    /addToHistory/,
    '提交事务不得关闭历史（关闭后 Ctrl+Z 撤不到 mermaid 源码，正是 (A) 类缺陷）'
  )
  assert.doesNotMatch(commit, /\.dispatch\(/, '不要绕过 props.editor 用别的 view 派发事务')
  assert.match(commit, /tr\.replaceWith\([\s\S]*schema\.text\(source\)/, '非空源码写回')
  assert.match(commit, /tr\.delete\(pos \+ 1, pos \+ node\.nodeSize - 1\)/, '空源码走 delete')
  // 一次编辑只允许一个事务：commit 里不能有第二个会改文档的写回
  assert.equal(
    (commit.match(/tr\.(?:replaceWith|delete)\(/g) || []).length,
    2,
    '两个分支各一处（同一事务）'
  )
})

// ─── ③ 焦点在块外时 Ctrl+Z 撤销：应用层投递到主编辑器 ───────────────────────
test('焦点在块外时 Ctrl+Z 撤销：window 捕获阶段把按键交给主编辑器 undo/redo', () => {
  assert.match(
    viewScript,
    /window\.addEventListener\('keydown', onGlobalHistoryKey, true\)/,
    '必须在 window 捕获阶段监听（焦点在 body 时编辑器根节点收不到）'
  )
  const handler = fnBody(viewScript, 'function onGlobalHistoryKey', 'onMounted(')
  assert.match(handler, /historyIntent\(e\)/, '按键归属走共享纯函数')
  assert.match(handler, /editor\.commands\.undo\(\)/, '撤销必须复用主编辑器既有命令')
  assert.match(handler, /editor\.commands\.redo\(\)/, '重做同样复用')
  assert.doesNotMatch(
    handler,
    /new History|history\(|prosemirror-history/,
    '不许新增第二套撤销实现（只做投递）'
  )
  assert.match(handler, /e\.preventDefault\(\)/, '命中后要吞掉浏览器默认行为')
  assert.match(handler, /e\.stopPropagation\(\)/, '命中后不再让别的处理器重复撤销')
})

test('焦点不在嵌套编辑器时不由嵌套撤销：编辑面/模态层/源码模式三道路闸都在命令之前', () => {
  const handler = fnBody(viewScript, 'function onGlobalHistoryKey', 'onMounted(')
  const nestedAt = handler.indexOf('isNestedEditorTarget(e.target')
  const undoAt = handler.indexOf('editor.commands.undo()')
  assert.ok(nestedAt >= 0, '必须有 isNestedEditorTarget 判定')
  assert.ok(undoAt > nestedAt, '焦点在 textarea/CM/PM 里时必须先 return，不能抢按键')
  assert.match(handler, /ui\.editorMode === 'source'/, '源码模式让给源码 textarea 自己的撤销')
  assert.match(handler, /\[role="dialog"\]\[aria-modal="true"\]/, '对话框开着时不越过模态层改文档')
  assert.match(handler, /files\.draftRestore/, '草稿恢复提示挂着时不接')
  assert.match(
    viewScript,
    /window\.removeEventListener\('keydown', onGlobalHistoryKey, true\)/,
    '卸载时必须摘掉监听（避免路由往返后多份处理器叠加）'
  )
})
