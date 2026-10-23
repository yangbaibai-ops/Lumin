// ─── 应用外链（唯一配置源）───────────────────────────────────────────────────
//
// 与 `feedback.ts` 同一口径：URL 不散落在模板里，改地址只改这一处。
// 只允许 https；打开统一走 `window.luminAPI.shell.openExternal`
// （协议/域名白名单在主进程 `services/links.ts` 的 `safeExternalUrl` / `safeProjectUrl`）。

/** 主仓库（GitHub） */
export const REPO_GITHUB = 'https://github.com/yangbaibai-ops/Lumin'

/** 项目主页（package.json 的 homepage 同源；保留旧名，避免调用方大改） */
export const APP_HOMEPAGE = REPO_GITHUB

/** 镜像仓库：Gitee */
export const REPO_GITEE = 'https://gitee.com/yangbai-bai/Lumin'

/** 镜像仓库：GitCode */
export const REPO_GITCODE = 'https://gitcode.com/yangbaibai-ops/Lumin'

/** 「帮助 → 使用文档」：README 是当前随仓库发布的使用说明 */
export const APP_DOCS_URL = `${APP_HOMEPAGE}#readme`

/** 一个仓库镜像：`name` 是品牌名（三语同形，不做翻译），`url` 只用于外链 */
export interface RepoMirror {
  /** 稳定 id（验收锚点 `data-about-mirror="<id>"`；也用于日志/排序） */
  id: 'github' | 'gitee' | 'gitcode'
  /** 展示名（GitHub / Gitee / GitCode） */
  name: string
  /** 仓库地址（必须 https） */
  url: string
}

/**
 * 镜像清单（顺序 = 菜单/关于页里的顺序）。
 *
 * ⚠️ GitHub 是**主仓库**，Gitee / GitCode 是镜像：新增镜像时只改这里，
 * 菜单、关于页与验收测试都从这一份清单派生。
 */
export const REPO_MIRRORS: readonly RepoMirror[] = [
  { id: 'github', name: 'GitHub', url: REPO_GITHUB },
  { id: 'gitee', name: 'Gitee', url: REPO_GITEE },
  { id: 'gitcode', name: 'GitCode', url: REPO_GITCODE }
]

/**
 * 应用自己发起的「项目主页」外链的**域名白名单**：只有主仓库与两个镜像可开。
 *
 * 为什么与文档链接分开：文档里的链接是用户内容（任意 https 站点都要能交给浏览器），
 * 而「帮助 → 项目主页」是我们自己写死的出口，没有理由能跳到别处。运行时第二道闸在
 * `src/main/services/links.ts` 的 `safeProjectUrl`（协议 + 域名双重校验）。
 */
export const PROJECT_LINK_HOSTS = ['github.com', 'gitee.com', 'gitcode.com'] as const

/** 该主机名是否属于项目主页白名单（精确匹配，不接受子域/后缀伪装） */
export function isProjectLinkHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/\.$/, '')
  return (PROJECT_LINK_HOSTS as readonly string[]).includes(h)
}
