// ─── EPUB 3 组装：**拆章 + 内嵌本地图片**（审计 §7 第 18 条）─────────────────────
//
// 改之前：不管文档多大都是一个 `chapter1.xhtml`，且 ZIP 条目里**没有图片** ——
// 正文里的本地图是 `lumin-file:///...`，EPUB 阅读器根本不认，导出的书里图全裂。
//
// 这里放**纯函数**（可单测，见 `tests/epub.test.mjs`）：拆章、找图片引用、把 src 换成
// ZIP 内的相对路径、生成 nav/content/opf。主进程负责"读图片字节 + 打包 ZIP"。
//
// 为什么图片走**独立条目**而不是 data URL：EPUB 阅读器对小图 data URL 普遍支持，
// 但一本带几十张截图的书写进 XHTML 会让单章文件巨大、阅读器解析变慢；
// 独立条目还能让阅读器的"图片查看"功能正常工作。

/** 一章 */
export interface EpubChapter {
  /** 章节标题（取自 `<h1>` 的纯文本；没有 h1 时用书名） */
  title: string
  /** 该章的 XHTML 片段（`<h1>` 保留在正文里） */
  html: string
  /** 章内引用的本地图片（原始 src，去重、保持出现顺序） */
  images: string[]
}

/** 把 HTML 里的标签剥掉，取纯文本（用于章节标题与 `<title>`） */
export function plainText(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取一段 HTML 里所有 `<img src>`（按出现顺序，含重复） */
export function imageSrcs(html: string): string[] {
  return [...String(html ?? '').matchAll(/<img\b[^>]*?\bsrc\s*=\s*"([^"]*)"/gi)].map((m) => m[1])
}

/** 本地图片（不是 http(s)/data/blob 的，才算"要打进 ZIP 的"） */
export function isLocalImageSrc(src: string): boolean {
  const s = (src ?? '').trim()
  if (!s) return false
  return !/^(https?:|data:|blob:|mailto:)/i.test(s)
}

/**
 * 按**顶层标题**（`<h1>`）拆章。
 *   * 没有 `<h1>`：整篇作为一章，标题用 `fallbackTitle`（保持旧行为，不做惊喜）；
 *   * `<h1>` 在开头之前还有内容（前言）：作为一章，标题用 fallbackTitle；
 *   * 只认 `<h1`：`<h2>` 拆章会把一章拆成十几节，反而难读。
 */
export function splitChapters(html: string, fallbackTitle: string): EpubChapter[] {
  const src = String(html ?? '')
  const indices = [...src.matchAll(/<h1\b/gi)].map((m) => m.index ?? 0)
  const chunks: { title: string; html: string }[] = []
  if (!indices.length) {
    chunks.push({ title: fallbackTitle, html: src })
  } else {
    if (indices[0] > 0) {
      const preface = src.slice(0, indices[0])
      if (plainText(preface)) chunks.push({ title: fallbackTitle, html: preface })
    }
    for (let i = 0; i < indices.length; i += 1) {
      const start = indices[i]
      const end = i + 1 < indices.length ? indices[i + 1] : src.length
      const chunk = src.slice(start, end)
      const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(chunk)
      const title = m ? plainText(m[1]) : fallbackTitle
      chunks.push({ title: title || fallbackTitle, html: chunk })
    }
  }
  const chapters = chunks.map((c) => ({
    title: c.title,
    html: c.html,
    images: [...new Set(imageSrcs(c.html).filter(isLocalImageSrc))]
  }))
  // 丢掉"只有标题、没有内容"的空章（写作时的占位标题很常见）—— 判据要去掉**那个 h1 本身**，
  // 否则每个标题章看起来都"有文字"。全被丢掉时（整篇就是几个空标题）退回原列表，
  // 不能产出 0 章的 EPUB（spec 要求 spine 至少一项）。
  const hasBody = (c: EpubChapter): boolean =>
    !!plainText(c.html.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>/i, '')) || c.images.length > 0
  const nonEmpty = chapters.filter(hasBody)
  return nonEmpty.length ? nonEmpty : chapters
}

/** src → ZIP 内相对路径（如 `images/img-1.png`）；不在表里的原样返回（例如远程图） */
export function embedImagePath(name: string): string {
  return `images/${name}`
}

/**
 * 把 `src` 按映射表换掉（只换映射里有的；远程/data URL 原样留着）。
 * 用**逐段替换**而不是正则整篇替换：src 里可能有正则元字符（`?` `+` `(`）。
 */
export function rewriteImageSrcs(html: string, mapping: Record<string, string>): string {
  return String(html ?? '').replace(
    /(<img\b[^>]*?\bsrc\s*=\s*")([^"]*)(")/gi,
    (whole, before: string, src: string, after: string) =>
      mapping[src] ? `${before}${mapping[src]}${after}` : whole
  )
}

/** 转义 XML 文本（属性与文本节点共用） */
export function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 单章 XHTML（EPUB3 要求 XHTML 命名空间与 lang） */
export function buildChapterXhtml(
  chapter: EpubChapter,
  meta: { title: string; lang: string; css: string }
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(meta.lang)}" xml:lang="${xmlEscape(meta.lang)}">
<head><meta charset="utf-8"/><title>${xmlEscape(chapter.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body><article class="md-preview">${chapter.html}</article></body>
</html>`
}

/** 目录页：每章一条 */
export function buildNavXhtml(
  chapters: EpubChapter[],
  meta: { title: string; lang: string; tocTitle: string }
): string {
  const items = chapters
    .map(
      (c, i) =>
        `        <li><a href="chapter-${i + 1}.xhtml">${xmlEscape(c.title || `${meta.tocTitle} ${i + 1}`)}</a></li>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(meta.lang)}" xml:lang="${xmlEscape(meta.lang)}">
<head><meta charset="utf-8"/><title>${xmlEscape(meta.tocTitle)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${xmlEscape(meta.tocTitle)}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`
}

/**
 * `content.opf`：manifest 收全部章节 + 图片 + 样式，spine 按章节顺序。
 * `cover` 可选（有封面图时写 properties="cover-image"）。
 */
export function buildOpf(meta: {
  title: string
  author: string
  lang: string
  chapters: number
  images: string[]
  id: string
  modified: string
}): string {
  const chapterItems = Array.from(
    { length: meta.chapters },
    (_, i) =>
      `    <item id="ch${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n')
  const imageItems = meta.images
    .map((name, i) => {
      const media = /\.png$/i.test(name)
        ? 'image/png'
        : /\.gif$/i.test(name)
          ? 'image/gif'
          : /\.svg$/i.test(name)
            ? 'image/svg+xml'
            : /\.webp$/i.test(name)
              ? 'image/webp'
              : 'image/jpeg'
      return `    <item id="img${i + 1}" href="${embedImagePath(name)}" media-type="${media}"/>`
    })
    .join('\n')
  const spine = Array.from(
    { length: meta.chapters },
    (_, i) => `    <itemref idref="ch${i + 1}"/>`
  ).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${xmlEscape(meta.lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${xmlEscape(meta.id)}</dc:identifier>
    <dc:title>${xmlEscape(meta.title)}</dc:title>
    <dc:language>${xmlEscape(meta.lang)}</dc:language>
    <dc:creator>${xmlEscape(meta.author)}</dc:creator>
    <meta property="dcterms:modified">${xmlEscape(meta.modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles.css" media-type="text/css"/>
${chapterItems}
${imageItems}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`
}
