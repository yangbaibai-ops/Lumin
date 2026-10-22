// ─── 「没改过就不该有草稿/提示」：结构契约 ──────────────────────────────────────
//
// 用户报障：「有时候明明我是第一次打开一个文档，就会弹出未保存的文档和未保存的草稿。」
// 真机复现后有两层成因（证据见报告）：
//   ① **打开不是编辑**：`normalizeMdMarkers` 在 onCreate 发起一次事务，`onUpdate` 把它
//      当用户输入 ⇒ 250ms 后把序列化器的规范形态写回 store。setext 标题 / `~~~` 围栏 /
//      缩进代码 / `__粗体__` / 表格对齐 / 行首 Tab 等语法的序列化结果与磁盘字节不同，
//      于是"打开即脏"，草稿与关窗提示全被这条假脏触发；
//   ② **草稿判定太宽**：草稿内容与磁盘只差尾随换行/CRLF 时，旧的逐字节比较仍判"可恢复"，
//      于是旧版本留下的假草稿在第一次打开时弹出横幅。
//
// 修法契约（这条测试守住不被改回去）：
//   * 载入归一化事务带 LOAD_NORMALIZE_META，onUpdate 见到就跳过；没有任何用户输入时
//     flushSync 不序列化回 store（`editorStore.dirty` 是唯一闸门）；
//   * `openPath` 只**处置**旧草稿（值得恢复的留下、与磁盘一致/过期的删掉），绝不写草稿；
//   * `writeDraft` 仍然用归一化比较兜底；撤销回基线由 `planDraftWrite` 的 `clear` 清理；
//   * 草稿按路径隔离：`writeDraft` 只写当前文档的键。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8')

const FILES = read('src/renderer/src/stores/files.ts')
const CORE = read('src/renderer/src/lib/filesCore.ts')
const RULES = read('src/renderer/src/lib/draftRules.ts')
const WYSIWYG = read('src/renderer/src/components/editor/WysiwygEditor.vue')
const MARKS = read('src/renderer/src/lib/editor/inlineMarks.ts')

/** 取一段源码（用起止锚点切片，断言只落在这段里） */
function slice(src, from, to) {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `切片锚点找不到：${from} … ${to}`)
  return src.slice(a, b)
}

test('打开文件：只处置旧草稿，绝不写草稿', () => {
  const open = slice(FILES, 'async openPath(', 'async openUntitled(')
  assert.doesNotMatch(open, /this\.writeDraft\(/, 'openPath 里不许有任何 writeDraft()')
  assert.match(open, /resolveOpenDraft\(/, 'openPath 必须走统一处置入口')
  assert.match(open, /planDraftOnOpen|resolveOpenDraft/, '处置判据来自纯函数')
})

test('resolveOpenDraft：没有恢复价值的旧草稿直接删掉（与磁盘一致 / 过期）', () => {
  const resolve = slice(FILES, 'async resolveOpenDraft(', '// ── 内容更新')
  assert.match(resolve, /planDraftOnOpen\(draft, content, path, mtimeMs\)/)
  assert.match(resolve, /if \(plan === 'purge'\)[\s\S]*?drafts\.remove\(key\)/)
  // 已有规范基线时，规范形态的旧草稿也直接清掉（旧版本写下的假草稿就是它）
  assert.match(
    resolve,
    /canonical &&[\s\S]*?samePath\(path, this\.current\?\.path \?\? null\)[\s\S]*?sameDocumentText\(draft\.content, canonical\)[\s\S]*?drafts\.remove\(key\)/
  )
  assert.match(resolve, /if \(plan === 'keep' && draft\)[\s\S]*?return draft/)
})

test('草稿判定：与磁盘一致（归一化）被忽略，且不比磁盘新也被忽略', () => {
  assert.match(
    RULES,
    /import \{ sameDocumentText \} from '\.\.\/\.\.\/\.\.\/shared\/documentText\.ts'/
  )
  assert.match(RULES, /if \(sameDocumentText\(draft\.content, content\)\) return 'purge'/)
  assert.match(RULES, /draft\.savedAt \?\? 0\) > mtimeMs \+ 1000 \? 'keep' : 'purge'/)
  assert.match(RULES, /return planDraftOnOpen\(draft, content, path, mtimeMs\) === 'keep'/)
})

test('真编辑写草稿、撤销清草稿：clean 但本会话写过 ⇒ clear', () => {
  assert.match(CORE, /export type DraftAction = 'write-now' \| 'debounce' \| 'clear' \| 'skip'/)
  assert.match(CORE, /if \(!input\.dirty\) return input\.lastDraftAt > 0 \? 'clear' : 'skip'/)
  // store：write-now 立即写；debounce 与 clear 都走同一个 writeDraft（干净时它只删不写）
  assert.match(FILES, /draftPlan === 'debounce' \|\| draftPlan === 'clear'/)
  assert.match(FILES, /if \(!isDocumentDirty\(cur\)\) \{[\s\S]*?drafts\.remove\(key\)/)
})

test('多文件隔离：草稿键只由当前文档路径决定，写的时候只写当前这一份', () => {
  assert.match(RULES, /export function draftKeyFor\(path: string \| null/)
  assert.match(RULES, /return fileDraftKey\(path\)/)
  // writeDraft 的键必须取 cur.path（不是别的窗口/别的文档），且内容也只取 cur
  const wd = slice(FILES, 'async writeDraft(', 'async save(')
  assert.match(wd, /const cur = this\.current/)
  assert.match(wd, /const key = this\.draftKey\(cur\.path\)/)
  assert.match(wd, /window\.luminAPI\.drafts\.save\(key, cur\.content, cur\.path\)/)
})

test('打开不是编辑：载入归一化事务不标脏、不序列化', () => {
  // 事务标记
  assert.match(MARKS, /export const LOAD_NORMALIZE_META = 'luminLoadNormalize'/)
  assert.match(MARKS, /tr\.setMeta\(LOAD_NORMALIZE_META, true\)/)
  assert.match(MARKS, /tr\.setMeta\('addToHistory', false\)/)
  // onUpdate：两种载入归一化（自带标记的 dispatch / 插件追加事务）都直接返回
  const update = slice(WYSIWYG, 'onUpdate: (', 'onBlur: (')
  assert.match(update, /transaction\?\.getMeta\(LOAD_NORMALIZE_META\) === true/)
  assert.match(update, /\(transaction\?\.steps\.length \?\? 0\) === 0/)
  assert.match(update, /appendedTransactions\.some\(\(tr\) => tr\.docChanged\)/)
  assert.match(update, /const autoNormalize =[\s\S]*?if \(autoNormalize\) \{/)
  assert.doesNotMatch(
    update.slice(0, update.indexOf('markDirty')),
    /markDirty/,
    '跳过分支必须在 markDirty 之前'
  )
  // flushSync：没有用户输入（editorStore.dirty=false）时不写 store
  const flush = slice(WYSIWYG, 'function flushSync(', 'function updateCursor(')
  assert.match(flush, /if \(!editorStore\.dirty\) return/)
  // 归一化后把规范 Markdown 记成第二干净基线（"编辑后又撤销"也能回到干净）
  assert.match(update, /noteCanonicalBaseline\(ed\)/)
  // onCreate 也必须记一次：有些文档不产生归一化事务，onUpdate 根本不会来
  assert.match(
    WYSIWYG,
    /deferAfterPmEvent\(\(\) => \{[\s\S]*?normalizeMdMarkers\(\)[\s\S]*?noteCanonicalBaseline\(ed\)/
  )
  assert.match(
    WYSIWYG,
    /function noteCanonicalBaseline\(ed: Editor\): void \{[\s\S]*?noteCanonicalContent\(getMarkdown\(ed\)\)/
  )
  assert.match(FILES, /noteCanonicalContent\(content: string\): void \{/)
  assert.match(FILES, /canonicalContent: null/)
  assert.match(FILES, /doc\.canonicalContent = null/)
  // 旧版本留下的"规范形态"假草稿：规范基线一出来就清掉（不弹、不占盘）
  assert.match(
    FILES,
    /samePath\(draft\.path, cur\.path\)[\s\S]*?sameDocumentText\(draft\.content, content\)[\s\S]*?this\.draftRestore = null[\s\S]*?drafts\.remove\(draft\.key\)/
  )
})
