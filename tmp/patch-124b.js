const fs = require('fs')
const p = 'tmp/sel-anchor-124.js'
let s = fs.readFileSync(p, 'utf8')
const reps = [
  // ① frame() 增加"模型锚点/头"（判"锚点落在哪"的权威口径）
  [
    "return { t: 0, sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), fromBlk: blk(s.from), toBlk: blk(s.to),",
    "return { t: 0, sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), modelAnchor: s.anchor, modelHead: s.head, fromBlk: blk(s.from), toBlk: blk(s.to),"
  ],
  // ② 锚点判据改用模型锚点（live 属性可能在"带内按下"时为空）
  [
    'const anchorInSrc = (f) => f.anchor != null && SRC.from <= f.anchor && f.anchor < SRC.to',
    'const anchorInSrc = (f) => f.modelAnchor != null && SRC.from <= f.modelAnchor && f.modelAnchor < SRC.to'
  ],
  [
    'const badAnchor = fs2.filter((f) => f.anchor != null && !anchorInSrc(f))',
    'const badAnchor = fs2.filter((f) => f.modelAnchor != null && !anchorInSrc(f))'
  ],
  // ③ 打印里带上模型锚点
  [
    "log(`   按下帧: sel=${fs2[0].sel} fromBlk=${fs2[0].fromBlk}",
    "log(`   按下帧: sel=${fs2[0].sel} 模型锚点=${fs2[0].modelAnchor} fromBlk=${fs2[0].fromBlk}"
  ],
  [
    "log(`   末帧:   sel=${mid.sel} fromBlk=${mid.fromBlk}",
    "log(`   末帧:   sel=${mid.sel} 模型锚点=${mid.modelAnchor} 头=${mid.modelHead} fromBlk=${mid.fromBlk}"
  ],
  // ④ 拖动距离：一律拖到源码字形里（user 模式用），保证"连续选中文字"真的发生
  [
    "        const r = await hold(label, { x: hx, y: vy }, { x: hx + 150, y: vy }, 12)",
    "        const tx = hk === '右' ? Math.min(blocks[curIdx].rect[2] - 8, hx + 120) : 1316\n        const r = await hold(label, { x: hx, y: vy }, { x: tx, y: vy }, 12)"
  ]
]
let n = 0
for (const [a, b] of reps) {
  if (s.includes(a)) { s = s.split(a).join(b); n++ } else console.log('MISS:', a.slice(0, 70))
}
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
