// 图片相对路径解析（renderer/lib/imageSrc.ts）
//
// 这是本轮修的一个真实功能缺口：`![](img/a.png)` 以前按「页面目录」解析，相对图片渲染不出来；
// 现在按「文档目录」解析成绝对路径再交给 lumin-file:// 协议。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  imageSrcForDoc,
  isAbsolutePath,
  isExternalImageSrc,
  joinDocPath,
  relativeDocPath,
  resolveImageSrc,
  setDocumentDirProvider
} from '../src/renderer/src/lib/imageSrc.ts'

test('远程 / 内联图片原样返回', () => {
  for (const src of [
    'https://x/y.png',
    'http://x/y.png',
    'data:image/png;base64,AAA',
    'blob:x',
    '//cdn/x.png'
  ]) {
    assert.equal(imageSrcForDoc(src, 'D:\\notes'), src)
    assert.equal(isExternalImageSrc(src), true)
  }
})

test('相对路径按文档目录解析（Windows 绝对路径）', () => {
  assert.equal(imageSrcForDoc('img/a.png', 'D:\\notes'), 'lumin-file:///D%3A/notes/img/a.png')
})

test('`..` 上溯不会越过盘符', () => {
  assert.equal(joinDocPath('D:\\notes\\sub', '..\\img\\a.png'), 'D:\\notes\\img\\a.png')
  assert.equal(joinDocPath('D:\\notes', '..\\..\\..\\img\\a.png'), 'D:\\img\\a.png')
})

test('分隔符混用、`.` 与多余斜杠都能规范化', () => {
  assert.equal(joinDocPath('D:/notes/', './img//a.png'), 'D:/notes/img/a.png')
  assert.equal(joinDocPath('D:\\notes', 'img/a.png'), 'D:\\notes\\img\\a.png')
})

test('已经是绝对路径（含 UNC）时不拼文档目录', () => {
  assert.equal(isAbsolutePath('C:\\x\\a.png'), true)
  assert.equal(isAbsolutePath('C:/x/a.png'), true)
  assert.equal(isAbsolutePath('\\\\server\\share\\a.png'), true)
  assert.equal(isAbsolutePath('img/a.png'), false)
  assert.equal(imageSrcForDoc('C:\\x\\a.png', 'D:\\notes'), 'lumin-file:///C%3A/x/a.png')
})

test('没有文档目录时保持原样（不瞎猜）', () => {
  assert.equal(imageSrcForDoc('img/a.png', null), 'img/a.png')
})

test('URL 转义：空格 / 中文 / # 不会把 URL 拆坏', () => {
  const url = imageSrcForDoc('图 片#1.png', 'D:\\我的 笔记')
  assert.equal(
    url,
    'lumin-file:///D%3A/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0/%E5%9B%BE%20%E7%89%87%231.png'
  )
  // 逐段解码后应当还原成原始绝对路径
  const decoded = url
    .replace('lumin-file:///', '')
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/')
  assert.equal(decoded, 'D:/我的 笔记/图 片#1.png')
})

test('POSIX 绝对路径（mac/Linux 场景）保留根', () => {
  assert.equal(joinDocPath('/home/u/notes', '../img/a.png'), '/home/u/img/a.png')
})

// ─── relativeDocPath：插入图片时算"相对当前文档"的 src ───────────────────────
// 图片统一放进工作区的 assets/，而 markdown 里的相对路径是相对**文档**解析的：
// 文档在 notes/ 里就得写 ../assets/x.png，否则渲染层按 notes/assets/x.png 去找，图裂掉。
test('relativeDocPath：同盘同目录 / 子目录 / 上溯', () => {
  assert.equal(relativeDocPath('D:\\ws', 'D:\\ws\\assets\\a.png'), 'assets/a.png')
  assert.equal(relativeDocPath('D:\\ws\\notes', 'D:\\ws\\assets\\a.png'), '../assets/a.png')
  assert.equal(relativeDocPath('D:\\ws\\a\\b', 'D:\\ws\\assets\\x.png'), '../../assets/x.png')
  assert.equal(relativeDocPath('D:\\ws\\notes', 'D:\\ws\\notes\\img\\a.png'), 'img/a.png')
})

test('relativeDocPath：大小写与分隔符混用不影响结果', () => {
  assert.equal(relativeDocPath('d:/WS/notes', 'D:\\ws\\assets\\a.png'), '../assets/a.png')
})

test('relativeDocPath：不同盘符相对不了就退回绝对路径', () => {
  assert.equal(relativeDocPath('C:\\ws', 'D:\\ws\\assets\\a.png'), 'D:\\ws\\assets\\a.png')
})

test('relativeDocPath：没有基准目录时原样返回', () => {
  assert.equal(relativeDocPath('', 'D:\\ws\\assets\\a.png'), 'D:\\ws\\assets\\a.png')
})

// ─── 点击守卫（用户报障：图片首帧能显示、点一下就永久裂）──────────────────────
// 点击图片节点时，mouseup 会把节点换成原文文本 `![alt](src)`（序列化必须保留原文）。
// 之后视图改由 widget 画图 —— **widget 写进 <img src> 的必须是解析后的绝对 URL**，
// 不能是 Markdown 原串（浏览器会按 out/renderer/index.html 解析 ⇒ 404）。
test('resolveImageSrc：相对 / 绝对 / 网络都给出可加载 URL（与节点首帧同一出口）', () => {
  setDocumentDirProvider(() => 'D:\\notes')
  try {
    assert.equal(resolveImageSrc('img/a.png'), 'lumin-file:///D%3A/notes/img/a.png')
    assert.equal(resolveImageSrc('C:/pics/b.png'), 'lumin-file:///C%3A/pics/b.png')
    assert.equal(resolveImageSrc('https://x/y.png'), 'https://x/y.png')
    assert.equal(resolveImageSrc('data:image/png;base64,AAA'), 'data:image/png;base64,AAA')
  } finally {
    setDocumentDirProvider(() => null)
  }
  assert.equal(resolveImageSrc('img/a.png'), 'img/a.png')
})

test('点击守卫：节点转原文后 widget 的显示 src 与节点首帧相同（不会退回相对串）', () => {
  setDocumentDirProvider(() => 'D:\\notes')
  try {
    const markdownSrc = 'img/a.png'
    // 节点首帧：renderHTML 走 resolveImageSrc
    const nodeRender = resolveImageSrc(markdownSrc)
    // 点击：节点 → 原文文本，src 仍是 Markdown 原串
    const rawText = `![](${markdownSrc})`
    const parsed = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(rawText)?.[1]
    assert.equal(parsed, markdownSrc)
    // 原文 widget：必须走同一个解析出口
    const widgetRender = resolveImageSrc(parsed)
    assert.equal(widgetRender, nodeRender)
    assert.notEqual(widgetRender, markdownSrc) // 不能是会把浏览器带回页面目录的相对串
  } finally {
    setDocumentDirProvider(() => null)
  }
})
