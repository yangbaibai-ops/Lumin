// 可访问性语义守卫（清单 §8 的 P0/P1 那几条）。
//
// 这些属性有一个共同点：**删掉/漏写时界面完全看不出来**，只有读屏器用户受影响。
// 所以口径是"属性与控件必须成对出现"，逐条列出来，而不是靠人记：
//   * 浮层必须 role=dialog + aria-modal（否则读屏器不知道"现在弹了一层"）；
//   * 开关必须 role=switch + aria-checked（否则读不出开/关）；
//   * 出错必须 role=alert（否则只对看得见的人存在）；
//   * 结果数这类"变了但看不见"的信息要有 live region；
//   * 文件列表的次要文字不能用装饰色 + 透明度（低对比度小字）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src')

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(vue|ts)$/.test(e.name)) out.push(p)
  }
  return out
}
const FILES = walk(RENDERER).map((f) => ({
  file: path.relative(RENDERER, f),
  text: fs.readFileSync(f, 'utf-8')
}))

const CONTEXT = 400

test('role="dialog" 的浮层必须同时有 aria-modal（否则读屏器不知道弹了一层）', () => {
  const bad = []
  for (const { file, text } of FILES) {
    for (const m of text.matchAll(/role="dialog"/g)) {
      const around = text.slice(m.index, m.index + CONTEXT)
      if (!/aria-modal/.test(around)) bad.push(`${file}@${m.index}`)
    }
  }
  assert.deepEqual(bad, [], `这些浮层缺 aria-modal：${bad.join(', ')}`)
})

test('role="switch" 必须同时给 aria-checked（否则读不出开/关）', () => {
  const bad = []
  for (const { file, text } of FILES) {
    for (const m of text.matchAll(/role="switch"/g)) {
      const around = text.slice(m.index, m.index + CONTEXT)
      if (!/aria-checked/.test(around)) bad.push(`${file}@${m.index}`)
    }
  }
  assert.deepEqual(bad, [], `这些开关缺 aria-checked：${bad.join(', ')}`)
})

test('错误通知必须用 role="alert" + assertive（失败要立刻打断播报）', () => {
  const file = FILES.find((f) => f.file.endsWith('NotificationCenter.vue'))
  assert.ok(file, '找不到 NotificationCenter.vue')
  assert.match(
    file.text,
    /:role="active\.level === 'error' \? 'alert' : 'status'"/,
    '通知带没有按级别切换 role（error 应为 alert）'
  )
  assert.match(
    file.text,
    /:aria-live="active\.level === 'error' \? 'assertive' : 'polite'"/,
    '通知带没有按级别切换 aria-live（error 应为 assertive）'
  )
})

test('"变了但看不见"的信息要有 live region（至少通知带 + 一处结果数）', () => {
  const live = FILES.filter((f) => /aria-live=/.test(f.text)).map((f) => f.file)
  assert.ok(live.length >= 2, `live region 太少（${live.length} 处）：${live.join(', ')}`)
  const gs = FILES.find((f) => f.file.endsWith('GlobalSearch.vue'))
  assert.ok(gs, '找不到 GlobalSearch.vue')
  assert.match(
    gs.text,
    /class="sr-only" role="status" aria-live="polite"[\s\S]{0,200}globalSearch\.hits/,
    '全局搜索的结果数没有 live region（读屏器不知道搜到几条）'
  )
})

test('文件列表的次要文字不用装饰色 + 透明度（三主题下都读不清）', () => {
  /**
   * `text-ink-3/NN` 是"装饰色再叠透明度"：`--ink-3` 本身只按图形 ≥3:1 守，
   * 再叠 60~90% 之后正文级小字远低于可读阈值。列表元信息改用 `--ink-2b`。
   *
   * 例外只有**装饰性**用法：旁边另有解释文字的 `aria-hidden` 图标（对比度要求不适用于纯装饰图形），
   * 以及注释里对旧写法的说明。这两类在扫描时跳过 —— 除此之外一律不许出现。
   */
  const fl = FILES.find((f) => f.file.endsWith('FileList.vue'))
  assert.ok(fl, '找不到 FileList.vue')
  /**
   * 唯一豁免：`text-ink-3/50` —— 空态那个 24px **装饰性**图标（同一元素带 `aria-hidden="true"`，
   * 旁边就是解释文字）。对比度要求不适用于纯装饰图形，其余一律不许出现。
   */
  const DECORATIVE = 'text-ink-3/50'
  assert.ok(fl.text.includes(DECORATIVE), `豁免项 ${DECORATIVE} 已经不存在了，请从豁免里删掉`)
  const bad = fl.text
    .split('\n')
    .filter((line) => !/^\s*(<!--|\/\/|\*)/.test(line))
    .flatMap((line) => [...line.matchAll(/text-ink-3\/\d+/g)].map((m) => m[0]))
    .filter((v) => v !== DECORATIVE)
  assert.deepEqual(bad, [], `FileList 里还有装饰色 + 透明度的小字：${bad.join(', ')}`)
})

test('mermaid 预览按钮既要 title 也要 aria-label（读屏器不念 title 的场合）', () => {
  const cb = FILES.find((f) => f.file.endsWith('CodeBlockView.vue'))
  assert.ok(cb, '找不到 CodeBlockView.vue')
  assert.match(
    cb.text,
    /:title="\$t\('editor\.editSource'\)"\s*\n\s*:aria-label="\$t\('editor\.editSource'\)"/,
    'mermaid 预览按钮缺 aria-label'
  )
})
