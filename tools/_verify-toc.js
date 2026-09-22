// 验收：目录（`[TOC]`）—— 插入 → 渲染 → 点击跳转 → markdown 往返 → 重新载入还原
//
// 为什么要有这条：`_verify-toc.js` 与 `_verify-toc-load.js` 原来都是**只打印不断言**的探针
//（自查报告 H1 点名的「0 断言被记成 PASS」那一类）。它们承载的功能（TOC 节点的插入/渲染/跳转/
// 往返/反向解析）在本仓库**没有别的覆盖**，所以按清单 §2.I 的口径「先升级成 harness 套件，
// 再归档原始探针」——两个脚本合并成这一条，全部改成 `report.check`。
//
// 已用 harness（改到谁迁谁，见 tools/README.md）。
'use strict'
const { connect, settle, sleep, openDocWith, waitEditor, Reporter, fatal } = require('./lib/harness')

/** 目录节点是否存在 + `.md-toc` 渲染出来的链接文本 */
const TOC_STATE = `(() => {
  const ed = window.__L.ed()
  let hasNode = false
  let markerCount = 0
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'tableOfContents') hasNode = true
    if (n.isText && n.text.includes('[TOC]')) markerCount += 1
  })
  const toc = document.querySelector('.md-toc')
  return JSON.stringify({
    hasNode,
    markerCount,
    hasDom: !!toc,
    links: toc ? [...toc.querySelectorAll('a')].map((a) => a.textContent.trim()) : []
  })
})()`

const MD = '# 一号标题\n\n正文段落。\n\n## 二号标题\n\n更多内容。\n\n### 三号标题\n\n结尾内容。'

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
  const report = new Reporter('目录 [TOC]：插入 / 渲染 / 跳转 / 往返 / 重载还原')

  await openDocWith(app, MD, 'toc.md')
  await sleep(600)

  // ① 光标移到文末 → 插入目录
  await ev(`(() => {
    const ed = window.__L.ed()
    ed.chain().focus().setTextSelection(ed.state.doc.content.size).run()
    return 'ok'
  })()`)
  await sleep(120)
  await ev(`(() => { window.__L.ed().commands.insertTableOfContents(); return 'ok' })()`)
  await sleep(600)

  const inserted = JSON.parse(await ev(TOC_STATE))
  report.note('插入后 ' + JSON.stringify(inserted))
  report.check('insert-creates-toc-node', inserted.hasNode === true, JSON.stringify(inserted))
  report.check(
    'renders-heading-links',
    inserted.hasDom === true && inserted.links.join('|') === '一号标题|二号标题|三号标题',
    JSON.stringify(inserted.links)
  )

  // ② 点第二个条目 → 光标落到「二号标题」（跳转）
  const clicked = await ev(`(() => {
    const a = document.querySelectorAll('.md-toc a')[1]
    if (!a) return false
    a.click()
    return true
  })()`)
  await sleep(400)
  const after = JSON.parse(
    await ev(`(() => {
      const ed = window.__L.ed()
      const sel = ed.state.selection
      // 语义要判的是「光标落在目标标题上」，不是「某个固定偏移处的文本」——
      // 点击可能把光标落在标题节点边界（from 处刚好是空串），所以要连前后一起看
      const near =
        ed.state.doc.textBetween(Math.max(0, sel.from - 12), sel.from) +
        ed.state.doc.textBetween(sel.from, Math.min(ed.state.doc.content.size, sel.from + 12))
      return JSON.stringify({
        near,
        nodeName: sel.$from.parent.type.name,
        collapsed: sel.empty
      })
    })()`)
  )
  report.note('点击后 ' + JSON.stringify(after))
  report.check(
    'link-click-moves-caret-to-heading',
    clicked === true && after.nodeName === 'heading' && after.near.includes('二号标题'),
    JSON.stringify(after)
  )

  // ③ markdown 往返：标记仍是 `[TOC]`，且三个标题一个字不少
  const mdOut = await ev(`window.__L.ed().storage.markdown.getMarkdown()`)
  report.check(
    'roundtrips-as-[TOC]-marker',
    typeof mdOut === 'string' &&
      mdOut.includes('[TOC]') &&
      ['一号标题', '二号标题', '三号标题'].every((h) => mdOut.includes(h)),
    JSON.stringify(mdOut).slice(0, 200)
  )

  // ④ 反向解析：把带 `[TOC]` 的 markdown 重新灌回编辑器 → 目录节点必须还原（不是一段字面文本）
  const reloadMd = '# 甲\n\n正文。\n\n[TOC]\n\n## 乙\n\n更多。'
  await ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.setContent(${JSON.stringify(reloadMd)})
    return 'ok'
  })()`)
  await sleep(700)
  const reloaded = JSON.parse(await ev(TOC_STATE))
  report.note('重载后 ' + JSON.stringify(reloaded))
  report.check(
    'reload-restores-toc-node',
    reloaded.hasNode === true && reloaded.hasDom === true && reloaded.markerCount === 0,
    JSON.stringify(reloaded)
  )
  report.check(
    'reload-links-reflect-new-headings',
    reloaded.links.includes('甲') && reloaded.links.includes('乙'),
    JSON.stringify(reloaded.links)
  )

  // ⑤ 边界：代码块里的 `[TOC]` 是**字面文本**，不该变成目录节点
  await ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.setContent('正文。\\n\\n\\\`\\\`\\\`\\n[TOC]\\n\\\`\\\`\\\`\\n')
    return 'ok'
  })()`)
  await sleep(700)
  const fenced = JSON.parse(await ev(TOC_STATE))
  report.note('围栏内 ' + JSON.stringify(fenced))
  report.check(
    'marker-inside-code-fence-stays-text',
    fenced.hasNode === false && fenced.markerCount === 1,
    JSON.stringify(fenced)
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
