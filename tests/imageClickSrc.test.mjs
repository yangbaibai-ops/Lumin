// 图片点击守卫（静态）：**所有写进 `<img src>` 的路径都必须经过 resolveImageSrc**。
//
// 用户报障：打开含相对/绝对路径图片的文档，首帧能显示；鼠标点一下图片后就永久裂。
// 真因是 imageToolbar 的原文 widget 直接把 Markdown 原串写进 `im.src`（点击时图片节点被
// 换成 `![alt](src)` 原文，视图改由 widget 画图）⇒ 相对路径按 out/renderer/index.html
// 解析 ⇒ 404。纯函数用例见 tests/imageSrc.test.mjs；这里钉住"调用点真的用了它"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf-8')

const toolbar = read('../src/renderer/src/lib/editor/imageToolbar.ts')
const extensions = read('../src/renderer/src/lib/editor/extensions.ts')

/** 只留代码（注释里可以提到旧写法，不能算调用点） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const toolbarCode = stripComments(toolbar)

test('图片 widget 的 src 走 resolveImageSrc（点击前后同一 URL）', () => {
  assert.match(toolbar, /import\s*\{[^}]*resolveImageSrc[^}]*\}\s*from\s*'\.\.\/imageSrc'/)
  assert.match(toolbarCode, /im\.src\s*=\s*resolveImageSrc\(img\.src\)/)
  // 回归守卫：不许再出现「原样把 Markdown 串塞进 img.src」
  assert.doesNotMatch(toolbarCode, /im\.src\s*=\s*img\.src(?!\w)/)
})

test('图片节点首帧渲染与 widget 共用同一个解析出口', () => {
  assert.match(extensions, /resolveImageSrc\(String\(HTMLAttributes\.src/)
  assert.match(extensions, /setDocumentDirProvider\(options\.getDocumentDir/)
})

test('没有文档目录时，宿主把工作区根注入成兜底基准', () => {
  // 否则相对图片会被浏览器按 out/renderer/index.html 解析 ⇒ 首帧就 404
  assert.match(extensions, /setWorkspaceRootProvider\(options\.getWorkspaceRoot/)
  assert.match(
    read('../src/renderer/src/components/editor/WysiwygEditor.vue'),
    /getWorkspaceRoot:\s*\(\)\s*=>\s*files\.root/
  )
})

test('加载失败只加错误标记，不替换/清空 src（重新打开可恢复）', () => {
  assert.match(toolbar, /data-img-error/)
  assert.doesNotMatch(toolbar, /im\.(?:removeAttribute|setAttribute)\(['"]src['"]/)
  assert.doesNotMatch(toolbar, /im\.src\s*=\s*['"]{2}/)
})
