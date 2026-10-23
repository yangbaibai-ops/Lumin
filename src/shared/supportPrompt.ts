// ─── 一次性「感谢 / 支持」提示的纯规则（可单测）────────────────────────────────
//
// 用户口径：**安装或首次使用**时弹一次原生提示（原创不易、欢迎 Star / 请作者喝咖啡），
// 关掉之后不再自动弹；但用户可以在**帮助菜单**里随时把它重新调出来。
//
// 这里只放判定与映射，不碰 DOM / IPC：
//   * `decideSupportPrompt`：这一刻该不该弹（已弹过 / 窗口不可见 / 用户正在输入）；
//   * `mapSupportDialogResponse`：`showMessageBox` 的下标 → 语义（0 继续写 / 1 去 Star）；
//   * 按钮顺序与「一次性闸」的键也在这里，避免主进程与渲染层各抄一份。
//
// 为什么判定要做成纯函数：一次性提示最危险的错误是「每次启动都弹」或「用户正在打字时
// 抢焦点」。这两条都只能靠"输入 → 该不该弹"的确定性映射钉住，而不是靠肉眼看一次运行时。

/** 首屏可交互之后延迟多久再弹（用户口径 ~1.5s：先把启动让过去，不抢首屏） */
export const SUPPORT_PROMPT_DELAY_MS = 1500

/** 「正在输入」的判据：最近一次键入（含输入法组合）距今小于这个窗口 */
export const SUPPORT_PROMPT_IDLE_MS = 2500

/** 原生框的按钮语义（下标 0 = 默认/取消出口） */
export const SUPPORT_DIALOG_BUTTONS = ['keepWriting', 'starRepo'] as const
export type SupportPromptChoice = (typeof SUPPORT_DIALOG_BUTTONS)[number]

/** 这一刻该做什么：弹 / 等窗口可见 / 等用户结束输入 / 永不再自动弹 */
export type SupportPromptDecision = 'show' | 'wait-visible' | 'wait-idle' | 'never'

export interface SupportPromptFacts {
  /** 手动入口（帮助菜单）：无视 `shown`，也不受"正在输入"限制 */
  manual: boolean
  /** 设置项 `supportPromptShown`：用户已经关过一次自动提示 */
  shown: boolean
  /** 窗口可见且在前台（最小化 / 被切走时都不算） */
  visible: boolean
  /** 用户此刻正在输入（最近有键入或输入法组合未结束） */
  typing: boolean
}

/**
 * 一次性判定（纯函数）。
 *
 * 手动入口的语义是"用户现在就要看"：`shown` 与 `typing` 都不拦它（只有一个例外：
 * 窗口不可见时先等它可见 —— 父窗口隐藏时的原生框没有意义）。
 * 自动入口的顺序刻意是「已弹过 → 可见性 → 输入」：先能确定"根本不该弹"，
 * 否则会在后台空转着等一个永远不会来的输入空闲。
 */
export function decideSupportPrompt(facts: SupportPromptFacts): SupportPromptDecision {
  if (facts.manual) return facts.visible ? 'show' : 'wait-visible'
  if (facts.shown) return 'never'
  if (!facts.visible) return 'wait-visible'
  if (facts.typing) return 'wait-idle'
  return 'show'
}

/**
 * 原生框返回值 → 语义：**只有下标 1 是「去点个 Star」**，其余（0 / Esc / 关窗 /
 * 平台异常给的未知值）一律回「继续使用」—— 这是最无害的出口：不写盘、不打开浏览器，
 * 只把提示关掉。
 */
export function mapSupportDialogResponse(response: number): SupportPromptChoice {
  return response === 1 ? 'starRepo' : 'keepWriting'
}

/**
 * 主进程 → 渲染层的结果。
 *
 * `manual` 是**主进程实际收到的那个请求**的标记（不是调用方自己的）：自动请求若与正在
 * 打开的手动框合并（`onceNativeDialog` 的"同一个问题只问一次"），它拿到的 `manual=true`
 * 就不会把 `supportPromptShown` 写成 true —— 手动查看永远不改变自动弹的既有状态。
 */
export type SupportPromptResult =
  | { status: 'choice'; choice: SupportPromptChoice; manual: boolean }
  | { status: 'deferred'; manual: boolean }
  /** 本次运行已经自动弹过（别的窗口/实例已在处理）：不写 flag、不再重试 */
  | { status: 'skipped'; manual: boolean }
