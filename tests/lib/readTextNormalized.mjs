// ─── 读仓库文本文件时统一行尾 ────────────────────────────────────────────────────
//
// 为什么需要它：`.gitattributes` 写的是 `* text=auto`（仓库内存 LF、检出按平台），
// GitHub Actions 的 Windows runner 用 `core.autocrlf=true` 检出 ⇒ 干净克隆里
// `docs/design-tokens.md`、`tools/README.md`、`electron-builder.yml` 等全是 CRLF，
// 而生成器（`tools/doc-tokens.js` / `tools/doc-facts.js`）拼出来的标记块永远是 LF。
// 于是"内容其实一致"却在 CI 上假红（本地 LF 工作区反而全绿）。
//
// 口径：测试只关心**内容**，不关心检出时的行尾 —— 读进来先归一成 LF 再比。
import fs from 'node:fs'

/** CRLF → LF（`\r\n` 只在行尾出现；单独 `\r` 不碰，旧 Mac 行尾另有测试管） */
export const normalizeEol = (text) => text.replace(/\r\n/g, '\n')

/** 与 `fs.readFileSync(file, 'utf-8')` 同签名，但保证返回 LF 文本 */
export function readTextNormalized(file) {
  return normalizeEol(fs.readFileSync(file, 'utf-8'))
}
