// ─── 分发链外部输入的**判据**（一处声明、三处使用）──────────────────────────────
//
// 报告（§7.4 A）点名这一块"缺真实仓库地址 / 官网 / 更新渠道 / 代码签名证书"。这些值**代码变不出来**
// —— 只有作者手里有。本模块只管一件事：**怎么判定"配了没有"**，并且只有这一份判据：
//   * 运行时：`main/services/updater.ts` 用它决定"要不要真的去查更新"
//     （占位地址一律跳过，免得用户机器上冒出莫名其妙的网络失败通知）；
//   * 构建期：`tools/distribution-check.mjs` 用它算出"还缺哪些外部输入"，
//     `--release` 时缺项即失败（免得带着 example.com 的更新地址发出去）；
//   * 单测：`tests/distribution.test.mjs` 把判据钉住。
//
// 为什么放 shared 而不是主进程：`node --test` 能直接 import（零 electron / 零 IO），
// 免得构建脚本自己再抄一份占位域名数组 —— 那种"两份各自漂移"的写法正是要避免的。
//
// ⚠️ 这里**只放判据，不放文案**：给开发者看的"怎么填 / 缺了会怎样"是构建工具的产物
// （`tools/distribution-check.mjs`），界面文案一律走语言包（见 tests/i18nHardcoded.test.mjs）。

/**
 * 占位域名/占位片段：落在这上面的值一律视为"还没配"。
 * 与 `electron-builder.yml` 的 publish、`docs/distribution.md` 的示例同源。
 */
export const PLACEHOLDER_HOSTS = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'your-domain',
  'yourname'
] as const

/** 这个值看起来是不是"还没填"（空串、占位域名、模板里的尖括号） */
export function isPlaceholderValue(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return true
  if (v.includes('<') || v.includes('>')) return true
  return PLACEHOLDER_HOSTS.some((host) => v.includes(host))
}

/** 分发链相关的事实（由构建脚本从 electron-builder.yml / package.json / 环境变量读出来） */
export interface DistributionFacts {
  /** electron-builder.yml 的 publish.provider */
  publishProvider: string
  /** publish.url（generic 渠道） */
  publishUrl: string
  /** publish.owner（github 渠道） */
  publishOwner: string
  /** publish.repo（github 渠道） */
  publishRepo: string
  /** package.json 的 repository（字符串形式） */
  repository: string
  /** package.json 的 homepage */
  homepage: string
  /** package.json 的 private 标志 */
  isPrivate: boolean
  /** 是否检测到签名凭据（CSC_LINK / WIN_CSC_LINK） */
  hasSigningCert: boolean
  /** 是否检测到签名口令（CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD） */
  hasSigningPassword: boolean
}

/**
 * 更新渠道是否指向真实地址。
 * generic 看 url、github 看 owner/repo —— 与 electron-builder 写进 app-update.yml 的字段一致，
 * 所以运行时读那份文件时用的是同一条判定（见 updater.updateChannelConfigured）。
 */
export function updateChannelReady(f: DistributionFacts): boolean {
  if (isPlaceholderValue(f.publishProvider)) return false
  if (f.publishProvider.toLowerCase() === 'github') {
    return !isPlaceholderValue(f.publishOwner) && !isPlaceholderValue(f.publishRepo)
  }
  return !isPlaceholderValue(f.publishUrl)
}

/** 仓库地址是否已填 */
export function repositoryReady(f: DistributionFacts): boolean {
  return !isPlaceholderValue(f.repository)
}

/** 官网/下载页是否已填 */
export function homepageReady(f: DistributionFacts): boolean {
  return !isPlaceholderValue(f.homepage)
}

/** 签名凭据是否齐备（证书 + 口令） */
export function signingReady(f: DistributionFacts): boolean {
  return f.hasSigningCert && f.hasSigningPassword
}
