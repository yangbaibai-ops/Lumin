// ─── 拼写检查：非自然语言区域必须显式 spellcheck="false" ────────────────────
//
// 正文根节点是唯一开启拼写检查的编辑面（用户口径）。代码块是嵌套的独立
// contenteditable、mermaid/公式是 textarea、图片源码是 PM 装饰出来的行内文本 ——
// 任何一处漏掉都会满屏红波浪线，而这类回归**不会报错**、只能靠肉眼发现。
// 所以这里做静态断言：文件里必须真的写了那个属性（不是靠 CSS，也不是靠父级继承
// 去猜）。运行时的 DOM 断言在验收脚本里另做（读 `.cm-content` 的属性）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8')

test('正文：ProseMirror 根节点显式 spellcheck="true"（唯一开启的编辑面）', () => {
  const src = read('src/renderer/src/components/editor/WysiwygEditor.vue')
  assert.match(src, /spellcheck:\s*'true'/, '正文根节点必须显式开启拼写检查')
})

test('代码块：CodeMirror 的 contentDOM 显式 spellcheck="false"', () => {
  const src = read('src/renderer/src/components/editor/CodeBlockView.vue')
  assert.match(
    src,
    /EditorView\.contentAttributes\.of\(\{\s*spellcheck:\s*'false'/,
    'CM 内容区是嵌套的 contenteditable，必须用 contentAttributes 关掉拼写检查'
  )
})

test('mermaid 源码框：textarea 显式 spellcheck="false"', () => {
  const src = read('src/renderer/src/components/editor/CodeBlockView.vue')
  const tag = src.slice(src.indexOf('class="mermaid-source-input"'))
  assert.match(tag.slice(0, 400), /spellcheck="false"/, 'mermaid 源码 textarea 要关掉拼写检查')
})

test('公式源码：textarea 显式 spellcheck="false"', () => {
  const src = read('src/renderer/src/lib/editor/mathPreview.ts')
  assert.match(
    src,
    /\.setAttribute\('spellcheck',\s*'false'\)/,
    '块级/行内公式的源码编辑框不能画波浪线'
  )
})

test('图片源码显形区：装饰属性显式 spellcheck="false"', () => {
  const src = read('src/renderer/src/lib/editor/imageToolbar.ts')
  const hits = src.match(/spellcheck:\s*'false'/g) ?? []
  assert.ok(hits.length >= 2, `图片源码/残缺源码两处都要关掉（实际 ${hits.length} 处）`)
})

test('源码模式 textarea：spellcheck="false"（Markdown 不是自然语言）', () => {
  const src = read('src/renderer/src/views/EditorView.vue')
  const tag = src.slice(src.indexOf('class="source-editor"'))
  assert.match(tag.slice(0, 400), /spellcheck="false"/, '源码模式 textarea 要关掉拼写检查')
})

test('全仓只有正文根节点开启 spellcheck="true"（防止某处误开）', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(ts|vue)$/.test(entry.name)) {
        const text = readFileSync(p, 'utf-8')
        // 只认代码里的属性赋值（注释里引用 spellcheck="true" 是文档，不算）
        if (/spellcheck:\s*'true'/.test(text)) offenders.push(p)
      }
    }
  }
  walk(join(ROOT, 'src/renderer/src'))
  assert.equal(offenders.length, 1, `只有正文根节点可以开启（实际：${offenders.join(', ')}）`)
  assert.match(offenders[0].replace(/\\/g, '/'), /WysiwygEditor\.vue$/)
})

test('主进程用的是 Electron 内置拼写接口（不是自造词典）', () => {
  const src = read('src/main/services/spellcheck.ts')
  for (const api of ['setSpellCheckerEnabled', 'setSpellCheckerLanguages']) {
    assert.match(src, new RegExp(`${api}\\(`), `缺 ${api}`)
  }
  assert.match(
    src,
    /\.availableSpellCheckerLanguages\b/,
    '语言清单必须来自 availableSpellCheckerLanguages'
  )
  assert.match(src, /\.addWordToSpellCheckerDictionary\(/, '缺 addWordToSpellCheckerDictionary')
})
