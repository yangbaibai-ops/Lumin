'use strict'
// 一次性补丁：把高水位护栏的状态与调用点接上（避免 PowerShell 内联引号地狱）
const fs = require('fs')
const p = 'src/renderer/src/lib/editor/imageToolbar.ts'
let s = fs.readFileSync(p, 'utf8')
const rep = (a, b, tag) => {
  if (!s.includes(a)) throw new Error('NOT FOUND: ' + tag)
  s = s.split(a).join(b)
  console.log('ok', tag)
}
rep(
  '      anchorLost: boolean\n    } | null = null',
  '      anchorLost: boolean\n      /** 高水位：远端达到过的最远文档位置（只增不减，除非指针真的反向 ≥4px） */\n      hw: number | null\n      /** 设置 hw 时的指针轴向距离（px） */\n      hwPx: number\n      /** 按下点屏幕坐标：高水位护栏用它判断"是否真的往回走" */\n      press: { x: number; y: number } | null\n    } | null = null',
  'state type'
)
rep(
  '              boxDrag = {\n                pressPos: at ? at.pos : null,\n                anchor: null,\n                focus: null,\n                anchorLost: false\n              }',
  '              boxDrag = {\n                pressPos: at ? at.pos : null,\n                anchor: null,\n                focus: null,\n                anchorLost: false,\n                hw: null,\n                hwPx: 0,\n                press: { x: event.clientX, y: event.clientY }\n              }',
  'init'
)
rep('            boxDragLive(editorView)', '            boxDragLive(editorView, event.clientX, event.clientY)', 'mousemove call')
fs.writeFileSync(p, s)
console.log('done')
