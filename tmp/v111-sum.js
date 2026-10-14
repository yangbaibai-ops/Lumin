'use strict'
module.exports = function sum(o) {
  const L = []
  const bg = (x) => (x === 'rgb(228, 230, 234)' ? 'EDGE' : x === 'rgba(0, 0, 0, 0)' ? 'OFF' : String(x))
  L.push(`tag=${o.tag} innerWidth=${o.innerWidth} 未激活=${JSON.stringify(o.boxes.state0)} 源码区间=${JSON.stringify(o.boxes.ranges)}`)
  L.push('图片盒 ' + JSON.stringify(o.boxes.widgets.map((w) => `from${w.from} ${w.l}..${w.r} @${w.t}..${w.b}`)))
  L.push('死区扫描 posAtCoords ' + JSON.stringify(o.deadzone))
  for (const g of o.gestures) {
    const a = g.afterUp
    const crossed = !a.empty && o.boxes.ranges.some((r) => a.from < r.from && a.to > r.to)
    L.push(`${g.name} 起点(${g.from.x},${g.from.y}) → 终点(${g.to.x},${g.to.y})`)
    L.push(`   pre=${g.pre.from}-${g.pre.to}-${g.pre.empty ? 'E' : '-'} beforeUp=${g.beforeUp.from}-${g.beforeUp.to}-${g.beforeUp.empty ? 'E' : '-'} 松手后=${a.from}-${a.to}-${a.empty ? 'E' : '-'} 跨过图片=${crossed}`)
    L.push(`   片段=${JSON.stringify(a.frag)}`)
    L.push(`   逐帧去重: ${JSON.stringify(g.seq)}`)
  }
  const k = o.keep
  if (k) {
    L.push('不破坏: 显形后 ' + JSON.stringify({ revealed: k.revealed.revealed, from: k.revealed.from, bg: bg(k.revealed.bg), ov: k.revealed.ov }))
    L.push('  点空白带 ⇒ ' + JSON.stringify(k.bandClick) + ' revealed=' + k.bandClickRevealed)
    L.push('  带内拖动 ⇒ ' + JSON.stringify(k.bandDrag) + ' | 同列字形拖动 ⇒ ' + JSON.stringify(k.glyphDrag) + ' | Δ=' + JSON.stringify(k.bandDragDelta))
    L.push('  字形上拖动 ⇒ ' + JSON.stringify(k.glyphDragOnly))
    L.push('  点别处 ⇒ ' + JSON.stringify(k.elsewhere) + ' | 点图 press=' + k.press + ' release=' + k.release + ' bg=' + bg(k.releaseBg))
    L.push('  显形逐帧: ' + JSON.stringify(k.revealSeq))
    L.push('  elementFromPoint=' + JSON.stringify(k.hit) + ' layoutSame=' + k.layoutSame)
    L.push('  编辑态=' + JSON.stringify({ cls: k.editing.cls, bg: bg(k.editing.bg), ov: k.editing.ov, ovEl: k.editing.ovEl }))
    L.push('  隐藏=' + JSON.stringify(k.hidden) + ' 往返逐字节=' + o.mdRoundtripSame + ' modal=' + k.modal)
  }
  return L.join('\n')
}
