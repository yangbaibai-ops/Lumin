// 导出资产本地化（src/main/exportAssets.ts）的单测。
//
// 审计 P1-1 的两条硬口径：
//   ① 导出 HTML/Word 后，文件里 `lumin-file:` 与 `file:///` 必须 **0 次**；
//   ② 图片离开本机仍能显示（内联为 data URI），公式字体不再是构建目录绝对路径。
// 本文件钉住纯函数层：URL 还原、字体块内联/删除、自检报错。真实导出由
// tools/_verify-export-portable.js 在隔离实例里跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INLINE_FONT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  assertPortable,
  dataUriFromBytes,
  findNonPortableRefs,
  formatForFontPath,
  inlineFontFaces,
  isLocalAssetSrc,
  localPathFromUrl,
  mimeForFontPath,
  mimeForImagePath
} from '../src/main/exportAssets.ts'

test('localPathFromUrl：lumin-file / file:/// / 绝对路径 / UNC / 相对路径', () => {
  assert.equal(
    localPathFromUrl('lumin-file:///C%3A/Users/me/%E5%9B%BE%20%E7%89%87/a.png'),
    'C:/Users/me/图 片/a.png'
  )
  assert.equal(localPathFromUrl('file:///C:/ws/a.png'), 'C:\\ws\\a.png')
  assert.equal(localPathFromUrl('file://server/share/a.png'), '\\\\server\\share\\a.png')
  assert.equal(localPathFromUrl('C:\\ws\\a.png'), 'C:\\ws\\a.png')
  assert.equal(localPathFromUrl('assets/a.png', 'C:\\ws\\docs'), 'C:\\ws\\docs\\assets\\a.png')
  // 远程 / data / 锚点不是本地资产
  for (const s of ['https://x/a.png', 'data:image/png;base64,AA', '#frag', 'blob:abc', '']) {
    assert.equal(localPathFromUrl(s), null, s)
  }
  // 相对路径没有基准目录 → null（调用方报 EXPORT_ASSET_UNRESOLVED）
  assert.equal(localPathFromUrl('assets/a.png'), null)
})

test('isLocalAssetSrc：只把本地形态算作需要内联的资产', () => {
  assert.equal(isLocalAssetSrc('lumin-file:///C%3A/a.png'), true)
  assert.equal(isLocalAssetSrc('file:///C:/a.png'), true)
  assert.equal(isLocalAssetSrc('assets/a.png'), true)
  assert.equal(isLocalAssetSrc('https://x/a.png'), false)
  assert.equal(isLocalAssetSrc('data:image/png;base64,AA'), false)
  assert.equal(isLocalAssetSrc(''), false)
})

test('MIME / format 映射覆盖 KaTeX 与常见图片', () => {
  assert.equal(mimeForImagePath('a.PNG'), 'image/png')
  assert.equal(mimeForImagePath('a.jpeg'), 'image/jpeg')
  assert.equal(mimeForImagePath('a.svg'), 'image/svg+xml')
  assert.equal(mimeForImagePath('a.avif'), 'image/avif')
  assert.equal(mimeForFontPath('KaTeX_Main-Regular.woff2'), 'font/woff2')
  assert.equal(mimeForFontPath('a.woff'), 'font/woff')
  assert.equal(mimeForFontPath('a.ttf'), 'font/ttf')
  assert.equal(formatForFontPath('a.woff2'), 'woff2')
  assert.equal(formatForFontPath('a.ttf'), 'truetype')
})

test('dataUriFromBytes：base64 可还原、上限常量是 8MB', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const uri = dataUriFromBytes(bytes, 'image/png')
  assert.match(uri, /^data:image\/png;base64,/)
  assert.deepEqual(Buffer.from(uri.split(',')[1], 'base64'), bytes)
  assert.equal(MAX_INLINE_IMAGE_BYTES, 8 * 1024 * 1024)
  assert.equal(MAX_INLINE_FONT_BYTES, 2 * 1024 * 1024)
})

test('inlineFontFaces：优先 woff2 内联，其余格式丢弃（不放大三倍）', () => {
  const css = `body{color:#000}
@font-face{font-family:KaTeX_Main;src:url("file:///app/KaTeX_Main-Regular.woff2") format("woff2"),url("file:///app/KaTeX_Main-Regular.woff") format("woff"),url("file:///app/KaTeX_Main-Regular.ttf") format("truetype")}
.md-preview{font-size:15px}`
  const seen = []
  const {
    css: out,
    inlined,
    dropped
  } = inlineFontFaces(css, (p) => {
    seen.push(p)
    return 'data:font/woff2;base64,QUJD'
  })
  assert.equal(inlined, 1)
  assert.equal(dropped, 0)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /KaTeX_Main-Regular\.woff2$/)
  assert.match(out, /src:url\("data:font\/woff2;base64,QUJD"\) format\("woff2"\)/)
  assert.equal(out.includes('.woff2"'), false)
  assert.equal(out.includes('format("woff")'), false)
  // 非字体 CSS 原样保留
  assert.match(out, /body\{color:#000\}/)
  assert.match(out, /\.md-preview\{font-size:15px\}/)
})

test('inlineFontFaces：data URI 来源（Vite 已内联）保留，同时清掉后面的 file:// 兜底', () => {
  const data = 'data:font/woff2;base64,AAAA'
  const css = `@font-face{font-family:KaTeX_Size3;src:url(${data}) format("woff2"),url("file:///app/KaTeX_Size3-Regular.woff") format("woff"),url("file:///app/KaTeX_Size3-Regular.ttf") format("truetype")}`
  const { css: out, inlined, dropped } = inlineFontFaces(css, () => null)
  assert.equal(inlined, 1)
  assert.equal(dropped, 0)
  assert.match(out, new RegExp(`src:url\\("${data}"\\) format\\("woff2"\\)`))
  assert.equal(out.includes('file://'), false)
  assert.equal(out.includes('format("woff")'), false)
})

test('inlineFontFaces：读不到字体 / 非本地 URL ⇒ 整块删除（公式退回系统字体）', () => {
  const css = `@font-face{font-family:KaTeX_Main;src:url("http://localhost:5173/f.woff2") format("woff2")}
@font-face{font-family:KaTeX_Math;src:url("file:///app/KaTeX_Math-Italic.woff2") format("woff2")}
p{margin:0}`
  const { css: out, inlined, dropped } = inlineFontFaces(css, () => null)
  assert.equal(inlined, 0)
  assert.equal(dropped, 2)
  assert.equal(/@font-face/i.test(out), false)
  assert.equal(/file:\/\//.test(out), false)
  assert.match(out, /p\{margin:0\}/)
})

test('findNonPortableRefs / assertPortable：命中 lumin-file 与 file:// 就抛', () => {
  const html = '<p>ok</p><img src="lumin-file:///C%3A/a.png"><a href="file:///C:/b.txt">b</a>'
  const refs = findNonPortableRefs(html)
  assert.deepEqual(refs.map((r) => r.kind).sort(), ['file-url', 'lumin-file'])
  assert.throws(() => assertPortable(html, '文档'), /EXPORT_NOT_PORTABLE/)
  assert.doesNotThrow(() => assertPortable('<img src="data:image/png;base64,AA"><p>ok</p>'))
})

test('自检对 data URI / 远程图 / 普通文本不误报', () => {
  const html =
    '<img src="data:image/png;base64,iVBORw0KGgo="><img src="https://example.com/a.png"><p>lumin-file 是协议名</p>'
  // 注意：正文里出现 `lumin-file`（没有冒号）不算引用；带冒号的文本会命中，这是有意的严格口径
  assert.deepEqual(findNonPortableRefs(html), [])
})
