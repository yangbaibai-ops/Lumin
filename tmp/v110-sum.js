'use strict'
// verify-110 结果摘要
module.exports = function sum(o) {
  const L = []
  const bg = (x) => (x === 'rgb(228, 230, 234)' ? 'EDGE' : x === 'rgba(0, 0, 0, 0)' ? 'OFF' : String(x))
  L.push(`tag=${o.tag} mode=${o.mode} innerWidth=${o.innerWidth} mdLen=${o.mdBefore} 起点=${JSON.stringify(o.pre && o.pre.sel)}`)
  L.push('points ' + JSON.stringify(o.points && { band: o.points.band, glyph: o.points.glyph }))
  if (o.A_X_band) {
    L.push('A/X 点空白带 逐帧去重:')
    for (const s of o.A_X_band.seq) L.push('   ' + s)
    L.push('   evs=' + JSON.stringify(o.A_X_band.evs) + ' frames=' + o.A_X_band.frames)
    L.push('A/Y 点源码字形 逐帧去重:')
    for (const s of o.A_Y_glyph.seq) L.push('   ' + s)
    L.push('   evs=' + JSON.stringify(o.A_Y_glyph.evs) + ' frames=' + o.A_Y_glyph.frames)
    L.push('A/Z 点图片激活 逐帧去重:')
    for (const s of o.A_Z_activate.seq) L.push('   ' + s)
    L.push('A 点真正的别处 ⇒ ' + JSON.stringify(o.A_elsewhere))
  }
  if (o.B) {
    for (const x of o.B) {
      L.push(`B① ${x.name} 起点(带 ${x.start.band.x},${x.start.band.y} / 字 ${x.start.glyph.x},${x.start.glyph.y}) 终点(${x.end.x},${x.end.y})`)
      L.push(`     空白带拖动 sel=${JSON.stringify(x.band)} | 同列字形拖动 sel=${JSON.stringify(x.glyph)} | Δfrom=${x.dFrom} Δto=${x.dTo}`)
      L.push('     拖动逐帧去重: ' + JSON.stringify(x.bandSeq))
    }
    L.push('B② 空白带单击 ⇒ ' + JSON.stringify(o.B_singleClick && o.B_singleClick.sel))
    L.push('B② 字形上拖动 ⇒ ' + JSON.stringify(o.B_glyphDrag && o.B_glyphDrag.sel))
    L.push('B  带内终点拖动（指针一路在带里）⇒ ' + JSON.stringify(o.B_inBandDrag && o.B_inBandDrag.sel))
  }
  if (o.keep) {
    const k = o.keep
    L.push('不破坏: 空白带单击 revealed=' + (k.bandClick && k.bandClick.revealed) + ' pos=' + JSON.stringify(k.bandClick && k.bandClick.sel))
    L.push('  显形手势 press=' + (k.revealGesture && k.revealGesture.press) + ' release=' + (k.revealGesture && k.revealGesture.release) + ' bg=' + bg(k.revealGesture && k.revealGesture.bg))
    L.push('  显形手势逐帧: ' + JSON.stringify(k.revealGesture && k.revealGesture.seq))
    L.push('  elementFromPoint=' + JSON.stringify(k.hit) + ' layoutSame=' + k.layoutSame)
    L.push('  编辑态: bg=' + bg(k.editing && k.editing.bg) + ' cls=' + (k.editing && k.editing.cls) + ' ov=' + (k.editing && k.editing.ov) + ' ovEl=' + (k.editing && k.editing.ovEl))
    L.push('  隐藏: ' + JSON.stringify(k.hidden) + ' 往返逐字节=' + o.mdRoundtripSame + ' modal=' + k.modal)
  }
  if (o.error) L.push('ERROR ' + o.error)
  return L.join('\n')
}
