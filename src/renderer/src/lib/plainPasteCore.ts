/**
 * 「粘贴为纯文本」的纯判据（不 import store / Vue / i18n，单测可直接加载）。
 *
 * 真正的插入动作在 `plainPaste.ts`（需要编辑器实例与剪贴板），这里只回答
 * "这段剪贴板文本要不要插、插什么"：
 *   * 空 / 只有换行 ⇒ 不插（不产生空事务、不弹"已粘贴"的假成功）；
 *   * CRLF / CR 统一成 LF（应用内部的文本永远是 LF，见 shared/eol.ts）。
 */
export interface PlainPastePlan {
  text: string
  insert: boolean
}

export function planPlainPaste(raw: string | null | undefined): PlainPastePlan {
  const text = (raw ?? '').replace(/\r\n?/g, '\n')
  return { text, insert: text.length > 0 }
}
