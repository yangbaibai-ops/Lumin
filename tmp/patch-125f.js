const fs = require('fs')
const p = 'src/renderer/src/lib/editor/imageToolbar.ts'
let s = fs.readFileSync(p, 'utf8')
let n = 0
// ① NATIVE_ATTR 说明改成"挂在 view.dom 上"
s = s.replace(`    /**
     * 第一百二十五轮：被"不透明底色"盖住、因而**必须交回原生选区绘制**的那些元素
     * （表格 \`thead/th\`、显形源码 \`.img-src-revealed\`…）。只在这个属性上重新打开 \`::selection\`
     * 的底色（见 markdown.css 里同一段说明），闸本身仍保持"整层独占" ⇒ 不会和原生叠成两层。
     */
    const NATIVE_ATTR = 'data-sel-band-native'`,
`    /**
     * 第一百二十五轮：本帧"有带被不透明底色盖住"时挂在 **\`view.dom\` 上**的标记 —— 只在这些
     * 不透明块（表格 \`thead/th\`、显形源码 \`.img-src-revealed\`、代码块…）里重新打开 \`::selection\`
     * 的底色（见 markdown.css 同一段说明），闸本身仍保持"整层独占" ⇒ 不会和原生叠成两层。
     * ⚠️ 必须挂在**根**上：往正文元素上写属性会惊动 PM 的 DOMObserver（实测直接把渲染进程卡死）。
     */
    const NATIVE_ATTR = 'data-sel-band-native'`)
// ② 标记工具：幂等写根属性
s = s.replace(`    /** 上一帧标成 \`data-sel-band-native\` 的元素（每帧/每次撤层都要摘掉，避免残留） */
    let nativeMarks: HTMLElement[] = []`,
`    /** 交回原生绘制的不透明块标记（幂等：值不变就不碰 DOM） */
    const setSelNative = (view: EditorView | null | undefined, on: boolean): void => {
      const dom = view?.dom
      if (!dom) return
      const v = on ? 'on' : null
      if (dom.getAttribute(NATIVE_ATTR) === v) return
      try {
        if (v) dom.setAttribute(NATIVE_ATTR, v)
        else dom.removeAttribute(NATIVE_ATTR)
      } catch {
        /* 视图已销毁：忽略 */
      }
    }`)
// ③ clearSelBands 里不再遍历元素
s = s.replace(`      for (const el of nativeMarks) el.removeAttribute(NATIVE_ATTR)
      nativeMarks = []
`, `      setSelNative(view, false)
`)
// ④ paintSelBands 里：去元素标记 → 只算"有没有被盖住"
s = s.replace(`      /** 上一帧标成"原生接管"的元素（每帧先摘掉，避免残留） */
      for (const el of nativeMarks) el.removeAttribute(NATIVE_ATTR)
      nativeMarks = []
      const dropIdx = new Set<number>()
      const marks = new Set<HTMLElement>()
      drawn.forEach((r, i) => {
        const cover = opaqueCoverAt(r)
        if (!cover) return
        dropIdx.add(i)
        marks.add(cover)
      })
      const kids = Array.from(node.children)
      for (const i of dropIdx) kids[i]?.remove()
      for (const el of marks) {
        el.setAttribute(NATIVE_ATTR, '')
        nativeMarks.push(el)
      }
      const hiddenRects = drawn.filter((_, i) => dropIdx.has(i))
      const rendered = drawn.filter((_, i) => !dropIdx.has(i))
      const handledByNative = (f: SelFrag): boolean => {
        if (f.block && Array.from(marks).some((m) => m === f.block || m.contains(f.block))) return true
        return f.rects.some((r) =>`,
`      const dropIdx = new Set<number>()
      drawn.forEach((r, i) => {
        if (opaqueCoverAt(r)) dropIdx.add(i)
      })
      const kids = Array.from(node.children)
      for (const i of dropIdx) kids[i]?.remove()
      setSelNative(view, dropIdx.size > 0)
      const hiddenRects = drawn.filter((_, i) => dropIdx.has(i))
      const rendered = drawn.filter((_, i) => !dropIdx.has(i))
      const handledByNative = (f: SelFrag): boolean => {
        return f.rects.some((r) =>`)
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
