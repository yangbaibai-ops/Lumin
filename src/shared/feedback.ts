// ─── 反馈渠道：**唯一配置源** ────────────────────────────────────────────────────
//
// 用户口径：「在顶部栏『帮助』中增加一个选项**『意见或 bug 反馈』**，点击后出现项目的
// issue 提交处（**可能有多个：github、gitee 等**）」。
//
// 为什么单独一个文件、而且只放数据：
//   * 「可能有多个」意味着将来**加一个渠道 = 加一条数据**（例如 Gitee：一行 `{ id, labelKey, url }`
//     + 三语各加一个 `menu.feedbackGitee` 键），不需要动模板、不需要动主进程；
//   * URL **不许**散在 .vue 模板里（散开之后"有哪些外链被打开"就没人能一眼看清了）；
//   * 「怎么打开」也不在这里 —— 打开统一走既有的 `window.luminAPI.shell.openExternal`
//     （协议白名单在主进程 `services/links.ts` 的 `safeExternalUrl`，本文件不做第二套）。
//
// 目前只登记 **GitHub**：用户只给了 GitHub 的 issue 地址，仓库里也没有任何 Gitee 线索；
// 地址是编不出来的，宁缺毋滥（加 Gitee 时在下面数组里补一条即可，见 `_verify-feedback.js` 的断言）。

/** 一个反馈渠道：渠道名走语言包（`menu.feedback*`），地址必须 https */
export interface FeedbackChannel {
  /** 稳定 id（验收锚点是 `data-menu-item="<labelKey>"`，id 用于人读的排序/日志） */
  id: string
  /** 渠道名的 i18n 键（`menu.feedbackGithub` 这类；品牌名在三种语言里都是拉丁文，见语言包注释） */
  labelKey: string
  /** issue / 反馈入口地址（**必须 https**，见 `isAllowedFeedbackUrl`） */
  url: string
}

/**
 * 反馈渠道清单（顺序 = 菜单里的顺序）。
 *
 * ⚠️ 加渠道时：① 在这里加一条；② 三份语言包各加一个 `menu.feedback<名>` 键（**文本级**插入，
 * 别用 JSON.parse→stringify 重写整份语言包）；③ 跑 `tools/_verify-feedback.js` ——
 * 它会把"菜单里的渠道"与这份清单**逐条对账**（少一条/多一条都会红）。
 */
export const FEEDBACK_CHANNELS: readonly FeedbackChannel[] = [
  {
    id: 'github',
    labelKey: 'menu.feedbackGithub',
    url: 'https://github.com/yangbaibai-ops/Lumin/issues'
  }
]

/**
 * 配置面的白名单：只允许 `https:`。
 *
 * 为什么这里也要判一次（主进程 `safeExternalUrl` 已经放行 http/https/mailto）：
 * 反馈渠道是**我们自己写死的出口**，没有理由用 `http:`（明文）或 `mailto:`；
 * 配置面挡住 = 将来有人往清单里写一个 `javascript:`/`http:` 时，**单测/套件立刻红**，
 * 而不是等它真的被交给系统浏览器。运行时的第二道闸仍在主进程（纵深防御）。
 */
export function isAllowedFeedbackUrl(url: string): boolean {
  return /^https:\/\/\S+$/i.test((url ?? '').trim())
}
