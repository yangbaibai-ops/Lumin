// 原生确认对话框：按钮下标 → 语义（关窗三选一 / 外部修改二选一）。
//
// 这两条是**数据安全**路径：映射写错的表现是"点取消却关窗""点不保存却保存"。
// 纯函数在 shared/nativeDialogs.ts；端到端（真弹原生框、点按钮、看文件/窗口）见
// tools/_verify-native-dialogs.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CLOSE_DIALOG_BUTTONS,
  CONFIRM_DIALOG_BUTTONS,
  EXTERNAL_DIALOG_BUTTONS,
  LEAVE_DIALOG_BUTTONS,
  mapCloseDialogResponse,
  mapConfirmDialogResponse,
  mapExternalDialogResponse,
  mapLeaveDialogResponse,
  planLeaveIntent
} from '../src/shared/nativeDialogs.ts'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

test('关窗原生框：0 保存 / 1 不保存 / 2 取消', () => {
  assert.deepEqual([0, 1, 2].map(mapCloseDialogResponse), ['save', 'discard', 'cancel'])
  assert.deepEqual(CLOSE_DIALOG_BUTTONS, ['save', 'discard', 'cancel'])
})

test('关窗原生框：未知下标/窗口销毁一律回 cancel（绝不误关）', () => {
  assert.equal(mapCloseDialogResponse(-1), 'cancel')
  assert.equal(mapCloseDialogResponse(7), 'cancel')
  assert.equal(mapCloseDialogResponse(Number.NaN), 'cancel')
})

test('外部修改原生框：0 重新加载，其余一律稍后', () => {
  assert.equal(mapExternalDialogResponse(0), 'reload')
  assert.equal(mapExternalDialogResponse(1), 'later')
  assert.equal(mapExternalDialogResponse(9), 'later')
  assert.deepEqual(EXTERNAL_DIALOG_BUTTONS, ['reload', 'later'])
})

// ─── 离开文档（放弃未保存修改）：本轮新增 ────────────────────────────────────
test('离开文档原生框：0 取消 / 1 放弃并离开，未知下标一律取消', () => {
  assert.equal(mapLeaveDialogResponse(0), 'cancel')
  assert.equal(mapLeaveDialogResponse(1), 'discard')
  assert.equal(mapLeaveDialogResponse(-1), 'cancel')
  assert.equal(mapLeaveDialogResponse(7), 'cancel')
  assert.equal(mapLeaveDialogResponse(Number.NaN), 'cancel')
  assert.deepEqual(LEAVE_DIALOG_BUTTONS, ['cancel', 'discard'])
})

test('离开文档：取消 ⇒ 留在当前文档（不丢内容/不清脏），放弃 ⇒ 继续原流程', () => {
  assert.equal(planLeaveIntent('cancel'), 'stay')
  assert.equal(planLeaveIntent('discard'), 'leave')
})

test('通用确认框：0 取消 / 1 确认，未知下标一律取消', () => {
  assert.equal(mapConfirmDialogResponse(0), 'cancel')
  assert.equal(mapConfirmDialogResponse(1), 'confirm')
  assert.equal(mapConfirmDialogResponse(9), 'cancel')
  assert.equal(mapConfirmDialogResponse(Number.NaN), 'cancel')
  assert.deepEqual(CONFIRM_DIALOG_BUTTONS, ['cancel', 'confirm'])
})

test('离开确认不允许「回车即放弃」：主进程必须 defaultId=0 / cancelId=0', () => {
  const main = read('src/main/ipc.ts')
  const at = main.indexOf(`ipcMain.handle('dialog:confirmLeaveUnsaved'`)
  assert.ok(at > 0, '主进程缺少 dialog:confirmLeaveUnsaved')
  const body = main.slice(at + 1)
  const handler = body.slice(0, body.indexOf(`ipcMain.handle('`))
  assert.match(handler, /mainT\('editor\.dirtyConfirmTitle'\)/, '标题必须取语言包')
  assert.match(handler, /mainT\('editor\.dirtyConfirmBody'\)/, '正文必须取语言包')
  assert.match(handler, /mainT\('editor\.dirtyConfirmDiscard'\)/, '「放弃并离开」必须取语言包')
  assert.match(handler, /defaultId:\s*0/, '默认焦点必须是「取消」')
  assert.match(handler, /cancelId:\s*0/, 'Esc/关框必须等于「取消」')
  assert.match(handler, /dialog\.showMessageBox\(win,/, '必须带父窗口的原生框')
})

test('离开确认的调用方已改为原生（渲染层不再走 ui.confirm / confirmTriple）', () => {
  const dialog = read('src/renderer/src/lib/dialog.ts')
  assert.match(dialog, /luminAPI\.dialog\.confirmLeaveUnsaved\(\)/)
  assert.match(dialog, /planLeaveIntent\(choice\) === 'leave'/)
  assert.doesNotMatch(dialog, /ui\.confirm\(/)
  assert.doesNotMatch(dialog, /ui\.confirmTriple\(/)
  assert.match(read('src/main/ipc.ts'), /ipcMain\.handle\('dialog:confirmLeaveUnsaved'/)
})

test('关窗/外部修改的呈现方式已是主进程原生框（不再走 ui.confirmTriple）', () => {
  const dialog = read('src/renderer/src/lib/dialog.ts')
  const external = read('src/renderer/src/lib/externalWatch.ts')
  const main = read('src/main/ipc.ts')
  assert.match(dialog, /luminAPI\.dialog\.confirmClose\(\)/, '关窗确认必须请求主进程原生框')
  assert.match(external, /luminAPI\.dialog\.externalChange\(\)/, '外部修改必须请求主进程原生框')
  assert.doesNotMatch(dialog, /ui\.confirmTriple\(/, '关窗路径不该再自绘三选一')
  assert.doesNotMatch(external, /ui\.confirmTriple\(/, '外部修改路径不该再自绘三选一')
  assert.match(main, /ipcMain\.handle\('dialog:confirmClose'/)
  assert.match(main, /ipcMain\.handle\('dialog:externalChange'/)
  // 两个 handler 都必须真的调用带父窗口的 showMessageBox
  const closeBody = main.slice(main.indexOf(`ipcMain.handle('dialog:confirmClose'`))
  assert.ok(closeBody.indexOf('dialog.showMessageBox(win,') > 0)
  const extBody = main.slice(main.indexOf(`ipcMain.handle('dialog:externalChange'`))
  assert.ok(extBody.indexOf('dialog.showMessageBox(win,') > 0)
})
