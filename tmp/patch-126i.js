const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
// codeblock 取"表格之后的那一块"（编辑器里可能不是 pre）
s = s.replace(
  "        else if (kind === 'codeblock') el = q('.ProseMirror pre').find((x) => (x.textContent || '').includes('flowchart'))",
  "        else if (kind === 'codeblock') {\n          const kids = q('.ProseMirror > *')\n          const ti = kids.findIndex((x) => x.querySelector && x.querySelector('table'))\n          el = (ti >= 0 ? kids[ti + 1] : null) || q('.ProseMirror pre').find((x) => (x.textContent || '').includes('flowchart')) || kids[kids.length - 1]\n        }"
)
// 跨表用例：连"松手后"也存一张（验收 ⑦ 要的是落定后的覆盖一致）
s = s.replace(
  "    if (label === 'table-fwd') { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-${label}-live.png`), path.join(__dirname, 'cross-table-settle.png')) } catch (e) { /* ignore */ } }",
  "    if (label === 'table-fwd') { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-${label}-live.png`), path.join(__dirname, 'cross-table-live.png')) } catch (e) { /* ignore */ } }"
)
s = s.replace(
  "    const settled = await json(`window.__P.frame()`)",
  "    await shot(`${label}-settled`)\n    const settled = await json(`window.__P.frame()`)\n    if (label === 'table-fwd') { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-${label}-settled.png`), path.join(__dirname, 'cross-table-settle.png')) } catch (e) { /* ignore */ } }"
)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
