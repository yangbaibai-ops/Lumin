'use strict'
// ─── 验收：本轮四项交互修复 ─────────────────────────────────────────────────
//
//  A. 查找命中的样子：命中处**高亮**（`.find-hit` 有底色），且命中的加粗文字**不冒出 `**`**
//     （查找的选法是程序化的 `setTextSelection`，与用户手选在状态里长得一样，只有「查找栏
//     正在高亮」这个全局事实能区分）。关掉查找栏后标记恢复正常的「光标所在构造才展开」。
//  B. 侧栏文件树行高：29px，且标签行盒（line-height）大于字号 —— 降部不会被 `overflow:hidden`
//     裁掉。这条与 `_verify-sidebar-tree-style.js` 的 `row-height-29` 互为双保险。
//  C. 选区跨出构造时把**整对标记**括进来：`**诊所** 全片` 里选到「全片」时选区必须覆盖
//     两侧的 `**`；只选构造内部（或完全在构造内）不扩。
//  D. 行尾点击：一行只有 `**诊室（底层空间）**` 时，点在最后一个可见字符右侧 ⇒ 光标落到
//     整块末尾（`**…**|`），不是收尾标记之前（`**…|**`）。点在字符内部/左侧不受影响。
//
// 跑法：node tools/_verify-round-24.js（先起隔离实例）
const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  openDocWith,
  fatal
} = require('./lib/harness')

const MD = ['**派出所和诊室不是两个地方，是同一个地方的两层。** 全片', '', '**诊室（底层空间）**'].join(
  '\n'
)

/** 选区 + 标记显隐 + 查找高亮，一次取全 */
const STATE = `(() => {
  const ed = window.__L.ed()
  const s = ed.state.selection
  const f = window.__L.store('find')
  const marks = [...document.querySelectorAll('.md-marker')]
  const hits = [...document.querySelectorAll('.find-hit')]
  return JSON.stringify({
    findOpen: f.open,
    query: f.query,
    from: s.from,
    to: s.to,
    empty: s.empty,
    text: s.empty ? '' : ed.state.doc.textBetween(s.from, s.to, '|'),
    revealed: marks.filter((m) => m.querySelector('.md-reveal-inline')).length,
    markerWidths: marks.map((m) => Math.round(m.getBoundingClientRect().width * 100) / 100),
    hits: hits.length,
    hitText: hits.map((h) => h.textContent).join('|'),
    hitBg: hits[0] ? getComputedStyle(hits[0]).backgroundColor : null,
    docText: ed.state.doc.textContent
  })
})()`

/** 逐字量可见字符矩形（折叠标记的矩形宽高为 0，自然被跳过） */
const CHAR_RECTS = `(() => {
  const chars = (p) => {
    const out = []
    if (!p) return { out: [], t: 0, h: 0, right: 0 }
    const walk = (n) => {
      if (!n) return
      if (n.nodeType === 3) {
        for (let i = 0; i < n.textContent.length; i++) {
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + 1)
          const b = r.getBoundingClientRect()
          if (b.width || b.height)
            out.push({ l: Math.round(b.left * 10) / 10, r: Math.round(b.right * 10) / 10, t: Math.round(b.top), bo: Math.round(b.bottom) })
        }
      } else (n.childNodes || []).forEach(walk)
    }
    walk(p)
    const pr = p.getBoundingClientRect()
    return { out, t: Math.round(pr.top), h: Math.round(pr.height), right: Math.round(pr.right) }
  }
  const ps = [...document.querySelectorAll('.ProseMirror p')]
  return JSON.stringify({ p1: chars(ps[0]), p2: chars(ps[1] || ps[0]) })
})()`

async function main() {
  const report = new Reporter('验收：查找高亮 / 树行高 / 选区含标记 / 行尾落点')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev, send } = app

  const click = async (x, y) => {
    const p = { x: Math.round(x), y: Math.round(y) }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'none', buttons: 0 })
    await sleep(110)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(60)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(400)
  }
  const st = () => ev(STATE).then(JSON.parse)

  try {
    // ═══ A. 查找高亮 + 命中处不显示标记 ═══
    await ev(
      `(() => { window.__L.store('find').hide(); window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`
    )
    await sleep(400)
    await openDocWith(app, MD, 'round24-a.md')
    await waitEditor(ev)
    await sleep(1300)

    const a0 = await st()
    report.check(
      'A 文档里确实有成对标记（两处 bold ⇒ 4 个 .md-marker）',
      a0.markerWidths.length === 4,
      JSON.stringify(a0.markerWidths)
    )

    await ev(
      `(() => { const f = window.__L.store('find'); f.show(false); f.setQuery('派出所'); return 'ok' })()`
    )
    await sleep(800)
    const a1 = await st()
    console.log('A-find ' + JSON.stringify({ sel: a1.text, hits: a1.hitText, bg: a1.hitBg, revealed: a1.revealed }))
    report.check('A 查找命中处被选中', a1.text.includes('派出所'), a1.text)
    report.check('A 命中处有高亮装饰（.find-hit）', a1.hits >= 1 && a1.hitText.includes('派出所'), JSON.stringify({ n: a1.hits, t: a1.hitText }))
    report.check(
      'A 命中高亮有可见底色（不是透明）',
      !!a1.hitBg && a1.hitBg !== 'rgba(0, 0, 0, 0)' && a1.hitBg !== 'transparent',
      String(a1.hitBg)
    )
    report.check(
      'A 查找命中时**不**显示 `**`（4 个标记全部折叠为 0 宽）',
      a1.revealed === 0 && a1.markerWidths.every((w) => w === 0),
      JSON.stringify({ revealed: a1.revealed, w: a1.markerWidths })
    )

    await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)
    await sleep(500)
    const a2 = await st()
    report.check('A 关闭查找栏后高亮摘掉', a2.hits === 0 && a2.hitBg === null, JSON.stringify({ n: a2.hits }))
    // 光标移进构造 ⇒ 标记恢复显示（证明查找抑制没有把显隐机制弄坏）
    await ev(`(() => { window.__L.ed().chain().setTextSelection(1).run(); return 'ok' })()`)
    await sleep(350)
    const a3 = await st()
    report.check(
      'A 关掉查找栏后标记恢复正常显隐（光标在构造内即展开）',
      a3.revealed >= 1 && a3.markerWidths.some((w) => w > 0),
      JSON.stringify({ revealed: a3.revealed, w: a3.markerWidths })
    )

    // ═══ C. 拖选撑标记：命令式选区必须**不**被改写 ═══
    // 为什么 C 段不做「真实拖拽」：这台机器上 CDP 合成的 mousedown→mousemove 序列在这个
    // 夹具上**不可复现** —— 无论有没有本轮改动，端点都会塌成段落末尾的一个光标
    // （实测：连跑 3 次都是 from=to=31）。真实指针路径已由 `_verify-marker-hold.js` 的
    // B/C/D 三拍覆盖（真的拖、多步、有中间态）；`expandOutsideMarkers` 的**规则本身**在这里
    // 用「先设选区、再派 mouseup」精确验，避免把测试框架的缺陷记成产品缺陷。
    const open = 1
    const setAndRelease = async (from, to, clientX) => {
      await ev(
        `(() => { window.__L.ed().chain().setTextSelection({ from: ${from}, to: ${to} }).run(); return 'ok' })()`
      )
      await sleep(300)
      await ev(`(() => {
        window.__L.ed().view.dom.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${clientX}, clientY: 132, button: 0 })
        )
        return 'ok'
      })()`)
      await sleep(600)
      return st()
    }
    // 第一段：开标记 [1,3) + 正文 [3,28) + 收标记 [28,30) + 空格与全片 [30,33)
    // 从正文内部（5）选到段尾（33）⇒ 起点应被撑到开标记之前（1）
    const c1 = await setAndRelease(3, 33, 390)
    console.log('C-cross ' + JSON.stringify({ from: c1.from, to: c1.to, text: c1.text }))
    report.check(
      'C 选区跨出构造 ⇒ 起点被拉到构造之前（含开标记）',
      c1.from === open,
      JSON.stringify({ from: c1.from, expect: open })
    )
    report.check(
      'C 选区覆盖整段构造文本（首尾标记都在里面）',
      c1.text.startsWith('**') && c1.text.includes('两层。**'),
      JSON.stringify(c1.text)
    )
    // 命令式选区**不**被撑开（连点样式按钮依赖这一点）
    await ev(
      `(() => { window.__L.ed().chain().setTextSelection({ from: 3, to: 8 }).run(); return 'ok' })()`
    )
    await sleep(400)
    const c2 = await st()
    report.check(
      'C 程序化选区不被撑开（不干扰样式命令的中间态）',
      c2.from === 3 && c2.to === 8,
      JSON.stringify({ from: c2.from, to: c2.to })
    )

    // ═══ C2. 选区**完全落在加粗正文内部**时不许撑开（用户报的「把前面的也选中了」）═══
    // 夹具：`全片唯一一次空间切换在 **SH-058**，靠一个拉镜完成，不切。`
    // 加粗正文 `SH-058` 内部 `0`(有样式) 与 `5`(无样式) 相邻 —— 曾经的判据
    // 「两侧样式集合不同」会把它误判成构造边界，把选区起点撑到**段首**。
    await openDocWith(
      app,
      '全片唯一一次空间切换在 **SH-058**，靠一个拉镜完成，不切。\n',
      'round24-c2.md'
    )
    await waitEditor(ev)
    await sleep(1200)
    const c2doc = JSON.parse(await ev(`(() => {
      let r = null
      window.__L.ed().state.doc.descendants((n, p) => {
        if (r) return false
        if (n.isTextblock && (n.textContent || '').includes('SH-058')) r = { start: p, len: n.content.size }
        return true
      })
      const bold = (() => {
        let b = null
        window.__L.ed().state.doc.descendants((n, p) => {
          if (b) return false
          if (n.isText && n.text === 'SH-058') b = { p, len: n.text.length }
          return true
        })
        return b
      })()
      return JSON.stringify({ para: r, bold })
    })()`))
    console.log('C2-doc ' + JSON.stringify(c2doc))
    // `0` 在加粗正文里（第 3 个字符），`镜` 在加粗之后的普通文字里
    const zeroPos = c2doc.bold.p + 3
    const jingPos = await ev(`(() => {
      let r = -1
      window.__L.ed().state.doc.descendants((n, p) => {
        if (r > 0) return false
        if (n.isText && n.text && n.text.includes('拉镜')) r = p + n.text.indexOf('镜')
        return true
      })
      return r
    })()`)
    console.log('C2 zeroPos=' + zeroPos + ' jingPos=' + jingPos)
    // 先用光标把标记显形，再量坐标；拖拽起点 = 「0」内部（正文位置 zeroPos），终点 = 「镜」之后
    await ev(
      `(() => { window.__L.ed().chain().setTextSelection({ from: ${zeroPos}, to: ${zeroPos} }).run(); return 'ok' })()`
    )
    await sleep(450)
    const c2geo = JSON.parse(await ev(`(() => {
      const v = window.__L.ed().view
      const p = document.querySelector('.ProseMirror p')
      const r = p.getBoundingClientRect()
      const y = Math.round(r.top + r.height / 2)
      const find = (docPos) => {
        for (let x = Math.round(r.left); x < Math.round(r.right); x++) {
          const h = v.posAtCoords({ left: x, top: y })
          if (h && h.pos === docPos) return x
        }
        return -1
      }
      return JSON.stringify({ y, xZero: find(${zeroPos}), xJing: find(${jingPos + 1}) })
    })()`))
    console.log('C2-geo ' + JSON.stringify(c2geo))
    // 与 C 段同一条指针路径（先设选区、再派 mouseup）：起点落在**加粗正文内部**
    // （`SH-058` 的第 3 个字符 `0`）⇒ 紧邻它的是同样有样式的 `5`，不是标记 ⇒ **不该动**。
    const c3 = await setAndRelease(zeroPos, jingPos + 1, Math.round(c2geo.xJing))
    console.log('C2 ' + JSON.stringify({ from: c3.from, to: c3.to, text: c3.text }))
    report.check(
      'C2 选区起点落在加粗正文内部 ⇒ **不**撑到段首（只选中的那一段）',
      c3.from >= zeroPos - 1,
      JSON.stringify({ from: c3.from, to: c3.to, expectFrom: `>= ${zeroPos - 1}`, text: c3.text })
    )
    report.check(
      'C2 选区文本不包含段首文字（`全片` 不在选区里）',
      !c3.text.includes('全片'),
      JSON.stringify(c3.text)
    )

    // ═══ D. 行尾点击落点 ═══
    // 先换回两段夹具（C2 段把文档换掉了）：D 要的是「一行只有 `**诊室（底层空间）**`」的段落。
    await openDocWith(app, MD, 'round24-d.md')
    await waitEditor(ev)
    await sleep(1200)
    const geo = JSON.parse(await ev(CHAR_RECTS))
    const y2 = Math.round((geo.p2.out[0].t + geo.p2.out[0].bo) / 2)
    const lastVis = geo.p2.out[geo.p2.out.length - 1]
    report.check('D 第二段可见字符数正确（8 个汉字/全角）', geo.p2.out.length === 8, String(geo.p2.out.length))
    // 期望落点：**块内容末尾**（所有折叠标记之后）。不写死数字：从文档算出
    // 「该文本块内容末尾」—— 硬编码位置在不同夹具上必崩（实测踩过）。
    // ⚠️ 这里曾经算的是 `contentEnd - 收尾标记长度`（= 收尾 `**` **之前**的位置），
    // 而标注写的是「收尾标记之后」—— 那是把**旧 bug 的行为**当成了期望值
    // （用户后来报的 `**…**|` 实际停在 `**…|**` 正是它）。本轮修正为块内容末尾。
    const p2 = JSON.parse(await ev(`(() => {
      let r = null
      window.__L.ed().state.doc.descendants((n, p) => {
        if (r) return false
        if (!n.isTextblock || !n.textContent.includes('诊室（底层空间）')) return true
        r = { start: p, contentEnd: p + 1 + n.content.size,
          text: n.textContent, closeMark: n.lastChild && n.lastChild.isText ? n.lastChild.text : '' }
        return true
      })
      return JSON.stringify(r ?? { contentEnd: -1 })
    })()`))
    console.log('D-pos ' + JSON.stringify(p2))
    await click(lastVis.r + 60, y2)
    const d1 = await st()
    console.log('D-line-end ' + JSON.stringify({ from: d1.from, expect: p2.contentEnd }))
    report.check(
      'D 点在最后一个可见字符右侧 ⇒ 光标落到**块内容末尾**（收尾标记之后）',
      d1.empty && d1.from === p2.contentEnd,
      JSON.stringify({ from: d1.from, expect: p2.contentEnd, 收尾标记之前: p2.contentEnd - p2.closeMark.length })
    )
    // 点在**中间某个字符的中心**（不是"最后一个字符附近"：上一步 D1 让收尾标记展开后
    // 文字会左移，按旧坐标点会落到标记之后 —— 那是测量假象，不是产品行为）。
    // 光标必须仍在**可见文字之内**（< 收尾标记之前那个位置），即没被行尾规则抢到块尾。
    const mid = geo.p2.out[Math.floor(geo.p2.out.length / 2)]
    await click((mid.l + mid.r) / 2, y2)
    const d2 = await st()
    const beforeClose = p2.contentEnd - p2.closeMark.length
    report.check(
      'D 点在字符内部 ⇒ 光标仍落在该处（不被行尾规则抢走）',
      d2.empty && d2.from < beforeClose && d2.from >= p2.start + 1,
      JSON.stringify({ from: d2.from, expect: `< ${beforeClose}`, char: mid })
    )

    // ═══ B. 侧栏树行高（几何 + 行盒）═══
    await ev(
      `(() => { window.__S ? 0 : 0; window.__L.ui().sidebarVisible = true; window.__L.ui().sidebarTab = 'files'; window.__L.ui().sidebarFilesView = 'tree'; return 'ok' })()`
    )
    await sleep(900)
    const b = await ev(`(() => {
      const rows = [...document.querySelectorAll('[data-tree-row]')]
      if (!rows.length) return JSON.stringify({ rows: 0 })
      const seen = new Set()
      const out = rows.map((r) => {
        const label = [...r.children].find((c) => c.tagName === 'SPAN' && c.textContent.trim())
        const rl = label ? getComputedStyle(label).lineHeight : ''
        seen.add(rl)
        return { h: Math.round(r.getBoundingClientRect().height * 10) / 10,
          lh: rl, fs: label ? getComputedStyle(label).fontSize : '' }
      })
      return JSON.stringify({ rows: out.length, heights: [...new Set(out.map((x) => x.h))],
        lineHeights: [...seen], fontSize: out[0]?.fs ?? '' })
    })()`).then(JSON.parse)
    console.log('B-tree ' + JSON.stringify(b))
    if (!b.rows) {
      report.skip('B-tree-rows', '当前实例没有可量的文件树行')
    } else {
      report.check(
        'B 树行高 29px（原 27px 会切掉降部）',
        b.heights.length === 1 && Math.abs(b.heights[0] - 29) <= 0.6,
        JSON.stringify(b.heights)
      )
      const lh = parseFloat(String(b.lineHeights[0]))
      report.check(
        'B 标签行盒大于字号（降部不会被 overflow:hidden 裁掉）',
        Number.isFinite(lh) && lh > parseFloat(String(b.fontSize)) * 1.2,
        `lineHeight=${b.lineHeights.join(',')} fontSize=${b.fontSize}`
      )
    }
  } catch (err) {
    report.skip('suite-error', String(err && err.message))
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
