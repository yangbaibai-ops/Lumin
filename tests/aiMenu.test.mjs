// ─── 右键「AI」子菜单：五项预设 + prompt 组装 + 提供者快照 ─────────────────────
//
// 用户口径：右键菜单里要有 AI 子菜单，至少「优化 / 续写 / 美化 / 理解 / 总结」。
// 这些项错了不会崩，只会"菜单少一项"或"发出去的指令不是那句" —— 前者肉眼能发现，
// 后者只有对照请求体才看得出来。所以这里把**清单与 prompt 拼装**都钉住：
//   * 五项的顺序 / 文案 key / 图标 / 唯一真实快捷键；
//   * `buildAiMenuPrompt` = 固定指令 + 空行 + 正文（正文为空时返回空串，不白发）；
//   * 右键菜单提供者为一级分类 `ai`，二级正是这五项；
//   * 动作层只把 kind 交给 store（不自己读编辑器/拼 prompt，避免两套口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

installTsExtensionResolve()

const { AI_MENU_PRESETS, aiMenuPreset, buildAiMenuActions, buildAiMenuPrompt, pickAiMenuSource } =
  await import('../src/shared/aiMenu.ts')
const { createDefaultProviders } = await import('../src/renderer/src/lib/editor/menu/providers.ts')

const t = (key) => key

test('五项预设：顺序 / 文案 key / 图标 / 快捷键（只有优化的 Ctrl+Alt+O 是真的）', () => {
  assert.deepEqual(
    AI_MENU_PRESETS.map((p) => p.kind),
    ['optimize', 'continue', 'polish', 'explain', 'summarize']
  )
  assert.deepEqual(
    AI_MENU_PRESETS.map((p) => p.labelKey),
    [
      'editorMenu.aiOptimize',
      'editorMenu.aiContinue',
      'editorMenu.aiPolish',
      'editorMenu.aiExplain',
      'editorMenu.aiSummarize'
    ]
  )
  assert.deepEqual(
    AI_MENU_PRESETS.map((p) => p.instructionKey),
    [
      'editorMenu.aiPrompt.optimize',
      'editorMenu.aiPrompt.continue',
      'editorMenu.aiPrompt.polish',
      'editorMenu.aiPrompt.explain',
      'editorMenu.aiPrompt.summarize'
    ]
  )
  for (const p of AI_MENU_PRESETS) assert.equal(p.icon, 'sparkles')
  assert.equal(aiMenuPreset('optimize').shortcut, 'Ctrl+Alt+O')
  // 其余四项不显示快捷键：Ctrl+Alt+K 被插入链接占用，S/R/C 属于既有 AI 命令
  assert.deepEqual(
    AI_MENU_PRESETS.filter((p) => p.shortcut).map((p) => p.kind),
    ['optimize']
  )
  assert.equal(aiMenuPreset('nope'), null)
})

test('prompt 组装：固定指令 + 空行 + 正文（逐字）', () => {
  assert.equal(
    buildAiMenuPrompt('optimize', '  一段需要优化的文字  ', t),
    'editorMenu.aiPrompt.optimize\n\n一段需要优化的文字',
    '正文要去掉首尾空白，指令与正文之间恰好一个空行'
  )
  assert.equal(
    buildAiMenuPrompt('summarize', '第一段\n\n第二段', t),
    'editorMenu.aiPrompt.summarize\n\n第一段\n\n第二段',
    '正文内部的段落结构必须原样保留'
  )
  assert.equal(buildAiMenuPrompt('continue', '   ', t), '', '空正文不发请求')
  assert.equal(buildAiMenuPrompt('unknown', '正文', t), '', '未知 kind 不发请求')
})

test('取文口径：选区 → 当前段落 → 全文（并带可替换的正确区间）', () => {
  const base = {
    selectionText: '',
    selectionRange: null,
    paragraphText: '当前段落',
    paragraphRange: { from: 10, to: 14 },
    documentText: '整篇文档'
  }
  assert.deepEqual(pickAiMenuSource(base), {
    text: '当前段落',
    from: 10,
    to: 14,
    kind: 'paragraph'
  })
  assert.deepEqual(
    pickAiMenuSource({ ...base, selectionText: '选中的文字', selectionRange: { from: 3, to: 8 } }),
    { text: '选中的文字', from: 3, to: 8, kind: 'selection' }
  )
  // 只有空白的选区不算选区（右键落在空白处时仍然取段落）
  assert.deepEqual(
    pickAiMenuSource({ ...base, selectionText: '   ', selectionRange: { from: 3, to: 5 } }),
    { text: '当前段落', from: 10, to: 14, kind: 'paragraph' }
  )
  assert.deepEqual(pickAiMenuSource({ ...base, paragraphText: ' ', documentText: '整篇文档' }), {
    text: '整篇文档',
    from: 0,
    to: 0,
    kind: 'document'
  })
})

/** 动作表：提供者只按 id 取项，labelKey/run 有即可 */
const ACTION_IDS = [
  'clipboard.copy',
  'clipboard.cut',
  'clipboard.paste',
  'clipboard.pastePlain',
  'clipboard.selectAll',
  'table.rowAbove',
  'table.rowBelow',
  'table.colBefore',
  'table.colAfter',
  'table.toggleHeader',
  'table.deleteRow',
  'table.deleteCol',
  'table.delete',
  'paragraph.text',
  'paragraph.h1',
  'paragraph.h2',
  'paragraph.h3',
  'paragraph.quote',
  'paragraph.bulletList',
  'paragraph.orderedList',
  'paragraph.taskList',
  'paragraph.codeBlock',
  'format.bold',
  'format.italic',
  'format.strike',
  'format.inlineCode',
  'insert.link',
  'insert.image',
  'insert.table',
  'insert.hr',
  'insert.toc',
  'insert.paragraphAbove',
  'insert.paragraphBelow',
  ...AI_MENU_PRESETS.map((p) => `ai.${p.kind}`)
]
const actions = {
  ...Object.fromEntries(
    ACTION_IDS.filter((id) => !id.startsWith('ai.')).map((id) => [
      id,
      { id, labelKey: `label.${id}`, run: () => true }
    ])
  ),
  // AI 项直接用真实派生函数（含 labelKey / icon / shortcut），避免测试自己另造一份
  ...buildAiMenuActions(() => true)
}
const ctx = {
  editor: null,
  hasSelection: false,
  inTable: false,
  inList: false,
  inTaskList: false,
  inBlockquote: false,
  inCodeBlock: false,
  headingLevel: null,
  table: null
}

test('右键菜单提供者：一级分类 AI，二级恰好五项且顺序固定', () => {
  const provider = createDefaultProviders(actions).find((p) => p.id === 'ai')
  assert.ok(provider, '缺少 AI 提供者')
  assert.equal(provider.when(ctx), true, 'AI 在任何场景都出场')
  const sections = provider.build(ctx)
  assert.equal(sections.length, 1)
  assert.deepEqual(
    [sections[0].id, sections[0].variant, sections[0].labelKey],
    ['ai', 'list', 'editorMenu.section.ai']
  )
  assert.deepEqual(
    sections[0].items.map((i) => i.id),
    ['ai.optimize', 'ai.continue', 'ai.polish', 'ai.explain', 'ai.summarize']
  )
  assert.deepEqual(
    sections[0].items.map((i) => i.labelKey),
    [
      'editorMenu.aiOptimize',
      'editorMenu.aiContinue',
      'editorMenu.aiPolish',
      'editorMenu.aiExplain',
      'editorMenu.aiSummarize'
    ]
  )
  assert.equal(sections[0].items[0].shortcut, 'Ctrl+Alt+O')
  for (const item of sections[0].items.slice(1)) assert.equal(item.shortcut, undefined)
})

test('动作层只把 kind 交给 store（不自己读编辑器 / 不发网络）', async () => {
  const called = []
  const built = buildAiMenuActions((kind) => {
    called.push(kind)
    return true
  })
  for (const preset of AI_MENU_PRESETS) {
    assert.ok(built[`ai.${preset.kind}`], `缺少动作 ai.${preset.kind}`)
    assert.equal(await built[`ai.${preset.kind}`].run(), true)
  }
  assert.deepEqual(called, ['optimize', 'continue', 'polish', 'explain', 'summarize'])
  // 没有注入 runAi 时如实返回 false（由 Action 调用方当成"未执行"），不静默成功
  assert.equal(await buildAiMenuActions()['ai.optimize'].run(), false)
})
