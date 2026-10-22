// ─── 切观看模式不该标脏：结构契约 ──────────────────────────────────────────────
//
// 用户报障：「打开文档什么都没做，只切了下渲染/双列/源码，就出现未保存小圆点，退出还提示保存。」
// 根因有两层（详见 shared/documentText.ts 的注释）：
//   ① 打开**末尾没有换行**的文件时，序列化按规则补一个 `\n`，逐字节比较把"补换行"当成修改；
//   ② 模式切换/回灌期间产生的非用户事务若走 `markDirty()`，也会让编辑面以为自己脏了。
//
// 修法契约（这条测试守它们不被改回去）：
//   * `files.dirty` 用归一化比较（`sameDocumentText`），不是 `content !== savedContent`；
//   * 草稿写入也用同一口径（否则干净文档会凭空写草稿，重启后弹草稿提示）；
//   * 编辑器有 `modeSwitching` 门控，切换期间 `markDirty()` 不置位；
//   * `useEditorMode` 在切换前后成对开关门控，且 flush 只在内容真的不同时写 store。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8')

const FILES = read('src/renderer/src/stores/files.ts')
const EDITOR = read('src/renderer/src/stores/editor.ts')
const MODE = read('src/renderer/src/composables/useEditorMode.ts')
const WYSIWYG = read('src/renderer/src/components/editor/WysiwygEditor.vue')

test('files.dirty：内容比较走归一化（容差 = 尾随换行 / 行尾差异）', () => {
  assert.match(FILES, /import \{ sameDocumentText \} from '\.\.\/\.\.\/\.\.\/shared\/documentText'/)
  const dirtyBlock = FILES.slice(FILES.indexOf('dirty(state)'), FILES.indexOf('/* ── 统计量'))
  assert.match(
    dirtyBlock,
    /sameDocumentText\(state\.current\.content, state\.current\.savedContent\)/
  )
  assert.doesNotMatch(dirtyBlock, /state\.current\.content !== state\.current\.savedContent/)
})

test('writeDraft：归一化相同就直接清理草稿、不写"假脏"草稿', () => {
  assert.match(FILES, /if \(sameDocumentText\(cur\.content, cur\.savedContent\)\)/)
  assert.match(FILES, /!sameDocumentText\(doc\.content, doc\.savedContent\)/)
})

test('editorStore：modeSwitching 门控存在，markDirty 在切换期间让行', () => {
  assert.match(EDITOR, /modeSwitching: false/)
  const mark = EDITOR.slice(EDITOR.indexOf('markDirty(): void'), EDITOR.indexOf('beginModeSwitch'))
  assert.match(mark, /if \(this\.modeSwitching\) return/)
  assert.match(EDITOR, /beginModeSwitch\(\): void \{[\s\S]*?this\.modeSwitching = true/)
  assert.match(EDITOR, /endModeSwitch\(\): void \{[\s\S]*?this\.modeSwitching = false/)
})

test('useEditorMode：切换成对开关门控；flush 只在内容真的不同时写 store', () => {
  assert.match(MODE, /import \{ sameDocumentText \} from '\.\.\/\.\.\/\.\.\/shared\/documentText'/)
  assert.match(MODE, /editorStore\.beginModeSwitch\(\)/)
  assert.match(MODE, /editorStore\.endModeSwitch\(\)/)
  // try/finally：flush 抛错也不能让门永久关着
  assert.match(MODE, /try \{[\s\S]*?flushWysiwyg\(\)[\s\S]*?finally \{[\s\S]*?endModeSwitch/)
  assert.match(
    MODE,
    /if \(!sameDocumentText\(md, files\.current\?\.content \?\? ''\)\) \{[\s\S]*?files\.setContent\(md, author\)/
  )
})

test('onUpdate 仍然经过 markDirty（真实编辑必须标脏，不能被门控误伤）', () => {
  assert.match(WYSIWYG, /onUpdate: \(\{ editor: ed \}\) => \{[\s\S]*?editorStore\.markDirty\(\)/)
})
