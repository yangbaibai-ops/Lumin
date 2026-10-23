'use strict'
// ─── 读仓库文本时统一行尾（LF）────────────────────────────────────────────────────
//
// 为什么需要：`.gitattributes` 写的是 `* text=auto`（仓库内存 LF、检出按平台），
// GitHub Actions 的 Windows runner 用 `core.autocrlf=true` 检出 ⇒ 干净克隆里
// `docs/design-tokens.md`、`tools/README.md`、`THIRD-PARTY-NOTICES.md` 等全是 CRLF，
// 而这里的生成器（`doc-tokens.js` / `doc-facts.js` / `gen-notices.js`）拼出来的内容
// 永远是 LF。直接逐字比较，`--check` 就会在干净克隆里报"过期"（本地 LF 工作区全绿）。
//
// 口径：`--check` 只关心**内容**，不关心检出时的行尾；`--write` 也按 LF 写。
const fs = require('fs')

/** 读成 LF 文本（CRLF → LF；单独 `\r` 不碰，旧 Mac 行尾另有 src/shared/eol.ts 管） */
const readLf = (file) => fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')

module.exports = { readLf }
