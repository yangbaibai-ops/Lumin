'use strict'
// 只做一件事：把用户报障的那段原文（及其最小子集）直接喂给 markdown-it，
// 打印 strong 的数量与内容 —— 这是「对照基准」（CommonMark 语义），
// 后面所有断言都以它为准，不自己发明规则。
const MarkdownIt = require('markdown-it')

const md = new MarkdownIt({ html: true, linkify: false, breaks: false, typographer: false })

const FULL =
  '**一句话**：这是一个**工程素养明显高于平均水平**的桌面应用 —— 安全基线正确、踩坑记录齐全、验收文化扎实、冷启动实测不到 1 秒；但它把最重的风险押在了**「保存路径」与「Markdown 保真」**这两件写作工具的信：**写盘不是原子操作、没有本地历史、没有任何往返保真验收**。工程侧最拖后腿的是 **`npm run lint` 目前是坏的（912 errors）**、**没有 CI / 没有单元测试**、以及**验收脚本没有统一入口**。'

const CASES = [
  ['完整段落', FULL],
  [
    '小节 A（中文引号）',
    '但它把最重的风险押在了**「保存路径」与「Markdown 保真」**这两件写作工具的信'
  ],
  ['小节 B（行内代码+全角括号）', '工程侧最拖后腿的是 **`npm run lint` 目前是坏的（912 errors）**'],
  ['小节 C（纯中文）', '**一句话**'],
  ['小节 D（中文后接中文引号，无前后文）', '**「保存路径」**'],
  ['小节 E（英文后接中文引号）', 'a**「x」**b'],
  ['最小 1', '**「保存路径」与「Markdown 保真」**'],
  ['最小 2', '**「a」**'],
  ['最小 3', '**（a）**'],
  ['最小 4', '**a（b）c**'],
  ['最小 5', '**`npm run lint` 目前是坏的（912 errors）**'],
  ['对照 6', '**a**'],
  ['对照 7', '**a。**'],
  ['对照 8', '**a、b**']
]

function reportOf(text) {
  const html = md.render(text)
  const strongs = [...html.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) => m[1])
  const ems = [...html.matchAll(/<em>([\s\S]*?)<\/em>/g)].map((m) => m[1])
  return { html, strongs, ems }
}

for (const [name, text] of CASES) {
  const r = reportOf(text)
  console.log(`\n### ${name}`)
  console.log(`  in   : ${JSON.stringify(text)}`)
  console.log(`  html : ${r.html.replace(/\n/g, '\\n')}`)
  console.log(`  strong(${r.strongs.length}): ${JSON.stringify(r.strongs)}`)
  if (r.ems.length) console.log(`  em(${r.ems.length}): ${JSON.stringify(r.ems)}`)
}
