// 浏览器级快捷键策略（`src/shared/shortcuts.ts`）——**哪些 Electron/Chromium 自带的键被拦、
// 哪些应用自己的键绝对不能碰**的静态守卫。
//
// 为什么值得单测：`before-input-event` 里的判断**起个真窗口才测得到**，而这里的每一条都是
// 数据安全/可用性口径：
//   * 拦漏了 → 用户按 Ctrl+R 丢掉未保存内容（这一轮的用户报障）；
//   * 拦错了 → 应用自己的快捷键**整个失效**（`preventDefault()` 会同时吃掉渲染层 keydown 与
//     菜单加速键）。第二类比第一类更难发现，所以下面有一整段专门钉"应用自己的键必须放行"。
//
// 端到端那半在 `tools/_verify-devtools.js`（真窗口里发 Ctrl+R / F5 / 缩放键 / F12 再断言）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_OWNED_COMBOS,
  KNOWN_THIRD_PARTY_COLLISIONS,
  blockedShortcut,
  comboLabel,
  isAppOwnedCombo
} from '../src/shared/shortcuts.ts'

/** 造一份 `before-input-event` 的输入（默认 keyDown + 全修饰键为假） */
const key = (k, mods = {}, type = 'keyDown') => ({
  type,
  key: k,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods
})

test('刷新族：Ctrl/Cmd+R、Ctrl+Shift+R、F5、Ctrl+F5 全拦（用户报障点）', () => {
  // ★ 用户原话：取消"按 Ctrl+R 刷新页面"
  assert.equal(blockedShortcut(key('r', { control: true })), 'reload')
  assert.equal(blockedShortcut(key('R', { meta: true })), 'reload')
  // 硬刷新也是刷新
  assert.equal(blockedShortcut(key('r', { control: true, shift: true })), 'reload')
  // F5 一律拦（含 Ctrl+F5 / Shift+F5 这两条"强制刷新"）
  assert.equal(blockedShortcut(key('F5')), 'reload')
  assert.equal(blockedShortcut(key('f5', { control: true })), 'reload')
  assert.equal(blockedShortcut(key('F5', { shift: true })), 'reload')
  // 只按 R（不带修饰键）是**打字**，绝不能拦
  assert.equal(blockedShortcut(key('r')), null)
})

test('DevTools 族：F12 与三种快捷键（含 macOS 的 Cmd+Alt 那一组）全拦', () => {
  assert.equal(blockedShortcut(key('F12')), 'devtools')
  assert.equal(blockedShortcut(key('f12', { control: true })), 'devtools')
  assert.equal(blockedShortcut(key('i', { control: true, shift: true })), 'devtools') // 开/关 DevTools
  assert.equal(blockedShortcut(key('j', { control: true, shift: true })), 'devtools') // 控制台
  assert.equal(blockedShortcut(key('c', { control: true, shift: true })), 'devtools') // 检查元素
  // macOS：Chromium 用 Cmd+Alt+I/J/C
  assert.equal(blockedShortcut(key('i', { meta: true, alt: true })), 'devtools')
  assert.equal(blockedShortcut(key('j', { meta: true, alt: true })), 'devtools')
  assert.equal(blockedShortcut(key('c', { meta: true, alt: true })), 'devtools')
})

test('DevTools 的判据不许连坐：只按 Ctrl+I / Ctrl+C / Ctrl+J 都是正常编辑键', () => {
  // Ctrl+I = 斜体（应用自己的编辑器键）、Ctrl+C = 复制（原生菜单 role）
  assert.equal(blockedShortcut(key('i', { control: true })), null)
  assert.equal(blockedShortcut(key('c', { control: true })), null)
  assert.equal(blockedShortcut(key('c', { control: true, alt: true })), null) // Win 上 Ctrl+Alt+C 不是 DevTools
  assert.equal(blockedShortcut(key('j', { control: true })), null)
  // Ctrl+Shift+C 之外，Ctrl+Shift+其他字母也不该被连坐
  assert.equal(blockedShortcut(key('k', { control: true, shift: true })), null)
})

test('查看源码 Ctrl/Cmd+U 被拦（并如实登记代码块里的第三方冲突）', () => {
  assert.equal(blockedShortcut(key('u', { control: true })), 'view-source')
  assert.equal(blockedShortcut(key('U', { meta: true })), 'view-source')
  // 单独按 u 是打字
  assert.equal(blockedShortcut(key('u')), null)
  // 取舍写进了模块（CodeMirror 在**代码块**里把 Mod-u 绑给 undoSelection）
  assert.ok(
    KNOWN_THIRD_PARTY_COLLISIONS.some((c) => c.combo === 'Mod+U' && c.note.length > 10),
    'Mod+U 的第三方冲突必须登记在 KNOWN_THIRD_PARTY_COLLISIONS 里（附理由）'
  )
})

test('整页缩放：Ctrl/Cmd + = / + / - / _ / 0 全拦（应用自己有字号设置）', () => {
  for (const k of ['=', '+', '-', '_', '0']) {
    assert.equal(blockedShortcut(key(k, { control: true })), 'zoom', `Ctrl+${k} 应被拦`)
  }
  // Shift 变体（Ctrl+Shift+= 放大、Ctrl+Shift+- 缩小）同样拦
  assert.equal(blockedShortcut(key('=', { control: true, shift: true })), 'zoom')
  assert.equal(blockedShortcut(key('-', { meta: true, shift: true })), 'zoom')
  // 不带修饰键的 - / = / 0 是打字
  assert.equal(blockedShortcut(key('-')), null)
  assert.equal(blockedShortcut(key('0')), null)
})

test('F7（caret browsing）与 F11（浏览器全屏）被拦；应用自己的专注模式不受影响', () => {
  assert.equal(blockedShortcut(key('F7')), 'caret-browsing')
  assert.equal(blockedShortcut(key('F7', { shift: true })), 'caret-browsing')
  assert.equal(blockedShortcut(key('F11')), 'fullscreen')
  // 应用的「专注模式」是 Mod+Shift+F（`view.focusMode`）—— 放行，见下一条用例
  assert.equal(blockedShortcut(key('f', { control: true, shift: true })), null)
})

test('只处理 keyDown（keyUp/char 不该再 preventDefault）', () => {
  assert.equal(blockedShortcut(key('F12', {}, 'keyUp')), null)
  assert.equal(blockedShortcut(key('r', { control: true }, 'keyUp')), null)
  assert.equal(blockedShortcut(key('r', { control: true }, 'char')), null)
})

test('★ 应用自己的快捷键**一律不被拦**（逐个核对过的那份清单）', () => {
  // 清单本身要有出处：来源文件与逐条说明写在 shortcuts.ts 的 APP_OWNED_COMBOS 上
  assert.ok(
    APP_OWNED_COMBOS.length >= 30,
    `清单太短（${APP_OWNED_COMBOS.length}），核对口径可能不对`
  )
  assert.equal(new Set(APP_OWNED_COMBOS).size, APP_OWNED_COMBOS.length, '清单里有重复项')
  for (const combo of APP_OWNED_COMBOS) {
    const input = inputOf(combo)
    assert.equal(
      isAppOwnedCombo(input),
      true,
      `${combo} 应该在 APP_OWNED_COMBOS 里被认出来（解析口径可能不一致）`
    )
    assert.equal(blockedShortcut(input), null, `${combo} 是应用自己的键，绝不能被拦`)
  }
})

test('★ 应用关键路径不会被拦（点名核对：打印/查找/替换/专注/加粗斜体/撤销/多光标）', () => {
  // 这些是最容易被"顺手拦掉"的：每一条都是应用功能，不是浏览器功能
  const mustPass = [
    ['p', { control: true }], // 打印…（file.print）
    ['f', { control: true }], // 查找
    ['h', { control: true }], // 替换
    ['f', { control: true, shift: true }], // 专注模式
    ['b', { control: true }], // 加粗（编辑器）
    ['i', { control: true }], // 斜体（编辑器）—— 与 Ctrl+Shift+I 只差 shift
    ['z', { control: true }], // 撤销
    ['y', { control: true }], // 重做
    ['d', { control: true }], // 代码块多光标加选
    ['/', { control: true }], // 循环编辑模式
    [',', { control: true }], // 设置
    ['s', { control: true }], // 保存
    ['n', { control: true }], // 新建
    ['o', { control: true }], // 打开
    ['w', { control: true }], // 关闭窗口
    ['k', { control: true }], // 快捷键设置
    ['p', { control: true, shift: true }], // 命令面板
    ['b', { control: true, shift: true }], // 切换侧栏
    ['e', { control: true, shift: true }], // 导出 PDF
    ['x', { control: true, shift: true }], // 删除线
    ['q', { control: true, shift: true }], // 引用
    ['e', { control: true }], // 行内代码
    ['c', { control: true }], // 复制
    ['v', { control: true }], // 粘贴
    ['x', { control: true }], // 剪切
    ['a', { control: true }], // 全选
    ['Tab', { control: true }], // 应用内切换窗口
    ['Tab', { control: true, shift: true }],
    ['Space', { control: true }] // 代码块补全
  ]
  for (const [k, mods] of mustPass) {
    assert.equal(
      blockedShortcut(key(k, mods)),
      null,
      `${comboLabel(key(k, mods))} 是应用自己的键，不能被拦`
    )
  }
})

test('日志串是 ASCII（主进程控制台按代码页解读字节，写中文会乱码）', () => {
  for (const input of [key('r', { control: true }), key('=', { control: true, shift: true })]) {
    const label = comboLabel(input)
    assert.match(label, /^[\x20-\x7e]+$/, `comboLabel 输出了非 ASCII：${label}`)
  }
  assert.equal(comboLabel(key('r', { control: true, shift: true })), 'Ctrl+Shift+R')
  assert.equal(comboLabel(key('F5')), 'F5')
  assert.equal(comboLabel(key('=')), '=')
  // 认不出的键名也要能打出可读的串（不能是 undefined）
  assert.equal(comboLabel({ type: 'keyDown', key: '' }), 'Key()')
})

/**
 * 把 `Mod+Shift+X` 这种表达式解析成 `KeyInput`（**测试侧**的小解析器）。
 *
 * 为什么在测试里另写一份而不是复用 `src/renderer/src/lib/keymap/keys.ts`：那份是渲染层模块
 * （用户可自定义键位的解析/匹配），而这里是主进程侧的策略比对 —— 直接 import 会把渲染层的
 * 依赖树拉进 Node 单测。两份都只服务各自的调用点，规则简单到不值得抽公共层；
 * 但**必须**在这里把语义写清：`Mod` = Windows/Linux 的 Ctrl **或** macOS 的 Cmd。
 */
function inputOf(combo) {
  const parts = combo.split('+')
  const k = parts.pop()
  return {
    type: 'keyDown',
    key: k,
    control: parts.includes('Mod') || parts.includes('Ctrl'),
    meta: false,
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt')
  }
}
