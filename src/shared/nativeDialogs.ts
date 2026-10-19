/**
 * ─── 原生对话框的按钮映射（纯函数，可单测）──────────────────────────────────────
 *
 * 用户口径：**关闭未保存文件**与**外部应用修改了文档内容**这两个确认必须用
 * Electron 主进程的 `dialog.showMessageBox(win, …)`（原生、父窗口绑定），
 * 不再用渲染层自绘的模态框。
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

/** 关窗对话框的按钮语义（主进程按这个顺序构造 buttons，渲染层只认语义） */
export const CLOSE_DIALOG_BUTTONS = ['save', 'discard', 'cancel'] as const
/** 外部修改对话框的按钮语义 */
export const EXTERNAL_DIALOG_BUTTONS = ['reload', 'later'] as const
