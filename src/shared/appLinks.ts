// ─── 应用外链（唯一配置源）───────────────────────────────────────────────────
//
// 与 `feedback.ts` 同一口径：URL 不散落在模板里，改地址只改这一处。
// 只允许 https；打开统一走 `window.luminAPI.shell.openExternal`
// （协议白名单在主进程 `services/links.ts` 的 `safeExternalUrl`）。

/** 项目主页（package.json 的 homepage 同源） */
export const APP_HOMEPAGE = 'https://github.com/yangbaibai-ops/Lumin'

/** 「帮助 → 使用文档」：README 是当前随仓库发布的使用说明 */
export const APP_DOCS_URL = `${APP_HOMEPAGE}#readme`
