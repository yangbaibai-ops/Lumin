/**
 * ─── 原生对话框的按钮映射（纯函数，可单测）──────────────────────────────────────
 *
 * 用户口径：**关闭未保存文件**、**外部应用修改了文档内容**、以及
 * **切换/离开文档时放弃未保存修改**这几个确认必须用 Electron 主进程的
 * `dialog.showMessageBox(win, …)`（原生、父窗口绑定），不再用渲染层自绘的模态框。
 * 其余确认类弹窗（删除文件 / 覆盖保存 / 清空历史…）也走同一层通用确认框。
 * 只有 toast（内部灰色滑动提示）按用户口径保留应用内。
 *
 * 为什么把按钮映射单独抽出来：`showMessageBox` 返回的是**数组下标**，而业务只认
 * 语义（save / discard / cancel / reload / later）。下标与语义的对应关系一旦写错，
 * 表现是"点取消却关窗 / 点不保存却保存"——最危险的一类错误，必须毫秒级可测。
 *
 * ⚠️ 不认识的 response（窗口被销毁、平台异常）一律回**最安全**的出口：
 * 关窗 → `cancel`（不关），外部修改 → `later`（不改内容）。
 */

export type NativeCloseChoice = 'save' | 'discard' | 'cancel'
export type NativeExternalChoice = 'reload' | 'later'
export type NativeLeaveChoice = 'discard' | 'cancel'
export type NativeConfirmChoice = 'confirm' | 'cancel'

/** 渲染层可以递给主进程的通用确认框（删除 / 覆盖 / 清空…）。文案由渲染层给（见 main/ipc.ts） */
export interface NativeConfirmOptions {
  /**
   * 稳定的动作标识（ASCII，如 `delete-file`）：主进程用它做
   * `onceNativeDialog` 的闸门键与日志标记，**不参与界面文案**。
   */
  kind: string
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险动作：主进程用 warning 图标（默认仍是「取消」聚焦，必须显式点确认） */
  danger?: boolean
}

/** 三选一（大文档「源码模式 / 仍然打开 / 取消」）：文案与顺序由渲染层给，主进程原样摆按钮 */
export interface NativeChooseOptions {
  kind: string
  title: string
  body: string
  /** 2–4 个按钮；下标 0 是默认/取消出口 */
  buttons: string[]
}

/** 关窗三选一：0 保存 / 1 不保存 / 2 取消（defaultId=0，cancelId=2） */
export function mapCloseDialogResponse(response: number): NativeCloseChoice {
  if (response === 0) return 'save'
  if (response === 1) return 'discard'
  return 'cancel'
}

/** 外部修改二选一：0 重新加载 / 1 稍后（defaultId=0，cancelId=1） */
export function mapExternalDialogResponse(response: number): NativeExternalChoice {
  return response === 0 ? 'reload' : 'later'
}

/**
 * 离开文档（放弃未保存修改）二选一：0 取消 / 1 放弃并离开
 * （defaultId=0、cancelId=0 —— 回车与 Esc 都落在「取消」，绝不误丢内容）。
 */
export function mapLeaveDialogResponse(response: number): NativeLeaveChoice {
  return response === 1 ? 'discard' : 'cancel'
}

/** 离开确认的出路：cancel ⇒ 留在当前文档（内容/光标/脏标记都不动）；discard ⇒ 继续原流程 */
export function planLeaveIntent(choice: NativeLeaveChoice): 'stay' | 'leave' {
  return choice === 'discard' ? 'leave' : 'stay'
}

/** 通用确认框二选一：0 取消 / 1 确认（defaultId=0、cancelId=0，未知下标一律取消） */
export function mapConfirmDialogResponse(response: number): NativeConfirmChoice {
  return response === 1 ? 'confirm' : 'cancel'
}

/** 关窗对话框的按钮语义（主进程按这个顺序构造 buttons，渲染层只认语义） */
export const CLOSE_DIALOG_BUTTONS = ['save', 'discard', 'cancel'] as const
/** 外部修改对话框的按钮语义 */
export const EXTERNAL_DIALOG_BUTTONS = ['reload', 'later'] as const
/** 离开文档对话框的按钮语义：取消在前，危险动作在后 */
export const LEAVE_DIALOG_BUTTONS = ['cancel', 'discard'] as const
/** 通用确认框的按钮语义 */
export const CONFIRM_DIALOG_BUTTONS = ['cancel', 'confirm'] as const
