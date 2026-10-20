// 快捷键校验（纯函数）的契约表。
//
// 用户报障原话：「单独的不需要控制按键的字母竟然也能设置，比如字母 f」。
// 这条测试把"能存/不能存"钉成数据表 —— 校验规则以后改一次，这里就必须同步改，
// 而不是靠人记得去点一遍设置界面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditKeybindings,
  conflictsWith,
  RESERVED_SHORTCUTS,
  validateKeybinding,
  validateStructure
} from '../src/renderer/src/lib/keymap/validate.ts'

const ok = (spec, opts) => {
  const r = validateKeybinding(spec, opts)
  assert.equal(r.ok, true, `${spec} 应该合法，实际被拒：${r.messageKey}`)
  return r
}

const bad = (spec, code, opts) => {
  const r = validateKeybinding(spec, opts)
  assert.equal(r.ok, false, `${spec} 应该被拒（期望 ${code}）`)
  assert.equal(r.code, code, `${spec} 的拒绝原因应为 ${code}，实际 ${r.code}`)
  return r
}

test('★ 打印字符必须带 Ctrl/Cmd/Alt：f / F / 1 / [ / / 一律拒绝', () => {
  for (const spec of ['f', 'F', '1', '[', '/', 'Shift+F', 'Shift+1']) {
    bad(spec, 'modifier-required')
  }
  // 规范化：小写 f 也会先变成 F（拒绝原因仍是"缺修饰键"，不是"格式错误"）
  assert.equal(validateStructure('f').spec, 'F')
})

test('允许单独使用：F1–F24、Escape、Shift+Tab', () => {
  for (const spec of ['F1', 'F12', 'F24', 'Escape', 'Shift+Tab']) {
    // F12 在保留表里，单独走保留分支；其余必须结构合法
    const r = validateStructure(spec)
    if (spec === 'F12') assert.equal(r.code, 'reserved')
    else assert.equal(r.ok, true, `${spec} 应允许单独使用：${r.code}`)
  }
  // F25 / 单独 Tab 不在白名单
  bad('F25', 'modifier-required')
  bad('Tab', 'modifier-required')
})

test('系统保留键：F5 / Ctrl+W / Ctrl+R / Ctrl+Shift+I 拒绝（并带原因）', () => {
  assert.equal(bad('F5', 'reserved').reserved?.reason, 'reload')
  assert.equal(bad('Ctrl+W', 'reserved').reserved?.reason, 'window-close')
  assert.equal(bad('Ctrl+R', 'reserved').reserved?.reason, 'reload')
  assert.equal(bad('Ctrl+Shift+I', 'reserved').reserved?.reason, 'devtools')
  assert.equal(bad('Ctrl+Q', 'reserved').reserved?.reason, 'app-quit')
  assert.equal(bad('Ctrl+0', 'reserved').reserved?.reason, 'zoom')
  // 表本身要无重复（同一条组合写两遍会让"哪个理由"变成随机）
  assert.equal(new Set(RESERVED_SHORTCUTS.map((r) => r.combo)).size, RESERVED_SHORTCUTS.length)
})

test('合法组合：Ctrl+Alt+T / Ctrl+Alt+F / Ctrl+Shift+P 通过，并返回规范化写法', () => {
  assert.equal(ok('Ctrl+Alt+T').spec, 'Ctrl+Alt+T')
  assert.equal(ok('Ctrl+Alt+F').spec, 'Ctrl+Alt+F')
  assert.equal(ok('Ctrl+Shift+P').spec, 'Ctrl+Shift+P')
  assert.equal(ok('Mod+Alt+H').spec, 'Ctrl+Alt+H')
  assert.equal(ok('Ctrl+Alt+ArrowUp').spec, 'Ctrl+Alt+ArrowUp')
})

test('★ 重复绑定：同一组合已属于别的命令 ⇒ 拒绝 + 指出占用者 + 给替代键', () => {
  const bindings = [
    { id: 'file.save', keys: 'Ctrl+S' },
    { id: 'insert.table', keys: 'Ctrl+Alt+T' }
  ]
  const conflict = bad('Ctrl+Alt+T', 'conflict', { selfId: 'insert.image', bindings })
  assert.deepEqual(conflict.conflictWith, ['insert.table'])
  assert.ok(conflict.suggestion, '冲突时应给出替代键')
  assert.equal(
    conflictsWith(conflict.suggestion, bindings, 'insert.image').length,
    0,
    `建议键 ${conflict.suggestion} 自己也冲突`
  )
  // 改自己：它当前就是这个键 → 不算冲突
  assert.equal(ok('Ctrl+Alt+T', { selfId: 'insert.table', bindings }).ok, true)
})

test('★ 历史数据审计：f 标记无效但不删除；默认 Mod+W 不因保留表被判红', () => {
  const issues = auditKeybindings([
    { id: 'file.save', keys: 'F', customized: true },
    { id: 'file.closeWindow', keys: 'Ctrl+W', customized: false },
    { id: 'insert.table', keys: 'Ctrl+Alt+T', customized: false },
    { id: 'insert.image', keys: 'Ctrl+Alt+T', customized: true }
  ])
  assert.equal(issues['file.save'].code, 'modifier-required')
  assert.equal(issues['file.closeWindow'], undefined, '默认键不查保留表')
  assert.equal(issues['insert.table'].code, 'conflict')
  assert.equal(issues['insert.image'].code, 'conflict')
})
