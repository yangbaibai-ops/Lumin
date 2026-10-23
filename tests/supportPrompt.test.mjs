// 一次性「感谢 / 支持」提示：判定、按钮映射、持久化与接线。
//
// 为什么值得单测：这条提示最危险的错误不是"文案错一个字"，而是
//   * **每次启动都弹**（用户明确要求"一次性"）；
//   * **用户正在打字 / 窗口在后台时抢焦点**；
//   * 帮助菜单手动重开时**把一次性状态写掉**（下次自动弹的语义被改变）；
//   * 点「去点个 Star」却打开了别的地址（或根本没打开）。
// 这些都是纯规则/接线问题，毫秒级就能钉住，不必等端到端跑一遍。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SUPPORT_DIALOG_BUTTONS,
  SUPPORT_PROMPT_DELAY_MS,
  decideSupportPrompt,
  mapSupportDialogResponse
} from '../src/shared/supportPrompt.ts'
import { defaultSettings } from '../src/shared/defaults.ts'
import { normalizeSettings, mergeSettings } from '../src/shared/settingsSchema.ts'
import { exportableSettings } from '../src/shared/settingsFile.ts'
import { APP_HOMEPAGE } from '../src/shared/appLinks.ts'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (p) => readFileSync(join(ROOT, p), 'utf-8')
const pack = (lang) =>
  JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8'))
const LANGS = ['zh-CN', 'en-US', 'ru-RU']

test('设置项：supportPromptShown 默认 false，并在归一/合并/导出的白名单里', () => {
  assert.equal(defaultSettings.supportPromptShown, false, '全新 profile 必须还没弹过')

  // 缺键（老 userData）⇒ 补默认值 false，不会被当成"已弹过"
  const fresh = normalizeSettings({}, defaultSettings).settings
  assert.equal(fresh.supportPromptShown, false)

  // 关掉之后写 true；重启读回来仍是 true（这就是"以后不再自动弹"的依据）
  const stored = normalizeSettings(
    { ...defaultSettings, supportPromptShown: true },
    defaultSettings
  ).settings
  assert.equal(stored.supportPromptShown, true)

  // 渲染层走 settings:update 的合并口径（mergeSettings），不得把它丢掉
  const merged = mergeSettings({ ...defaultSettings }, { supportPromptShown: true })
  assert.equal(merged.supportPromptShown, true)
  assert.equal(exportableSettings(stored).supportPromptShown, true, '导出设置里应保留该状态')
})

test('一次性判定：已弹过 ⇒ never；手动入口无视 shown 与 typing', () => {
  assert.equal(
    decideSupportPrompt({ manual: false, shown: true, visible: true, typing: false }),
    'never',
    '用户关过一次之后，自动入口永不再弹（不许"每次启动都弹"的兜底）'
  )
  assert.equal(
    decideSupportPrompt({ manual: true, shown: true, visible: true, typing: true }),
    'show',
    '帮助菜单是手动入口：已弹过、正在输入都照样打开'
  )
  assert.equal(
    decideSupportPrompt({ manual: true, shown: false, visible: false, typing: false }),
    'wait-visible',
    '窗口不可见时连手动入口也要等（隐藏父窗口上的原生框没有意义）'
  )
})

test('一次性判定：窗口不可见 / 正在输入 ⇒ 延后，绝不抢焦点打断输入', () => {
  assert.equal(
    decideSupportPrompt({ manual: false, shown: false, visible: false, typing: false }),
    'wait-visible',
    '最小化 / 在后台 ⇒ 等下次可见'
  )
  assert.equal(
    decideSupportPrompt({ manual: false, shown: false, visible: true, typing: true }),
    'wait-idle',
    '正在打字 ⇒ 等输入空闲'
  )
  assert.equal(
    decideSupportPrompt({ manual: false, shown: false, visible: true, typing: false }),
    'show'
  )
})

test('按钮映射：下标 0/未知 ⇒ keepWriting，1 ⇒ starRepo', () => {
  assert.deepEqual(SUPPORT_DIALOG_BUTTONS, ['keepWriting', 'starRepo'])
  assert.equal(mapSupportDialogResponse(0), 'keepWriting')
  assert.equal(mapSupportDialogResponse(1), 'starRepo')
  // Esc / 关窗 / 平台异常给的未知下标：最无害的出口是"继续使用"
  assert.equal(mapSupportDialogResponse(-1), 'keepWriting')
  assert.equal(mapSupportDialogResponse(2), 'keepWriting')
  assert.equal(mapSupportDialogResponse(99), 'keepWriting')
})

test('延迟：首屏可交互之后 ~1.5s 才弹（不占启动路径）', () => {
  assert.ok(SUPPORT_PROMPT_DELAY_MS >= 1200 && SUPPORT_PROMPT_DELAY_MS <= 2000)
})

test('主进程接线：原生 info 框、父窗口、onceNativeDialog 的 support 闸、仓库地址', () => {
  const ipc = read('src/main/ipc.ts')
  assert.match(ipc, /onceNativeDialog\(win, 'support'/, '必须复用一次性闸（键 = support）')
  assert.match(ipc, /type: 'info'/, '用户口径：type=info')
  assert.match(ipc, /defaultId: 0/)
  assert.match(ipc, /cancelId: 0/)
  assert.match(ipc, /mainT\('support\.line1'\)/)
  assert.match(ipc, /mainT\('support\.keepWriting'\)/)
  assert.match(ipc, /mainT\('support\.starRepo'\)/)
  assert.match(ipc, /openSupportRepo\(\)/, 'Star 按钮必须真的打开仓库')
  assert.match(ipc, /links\.safeExternalUrl\(APP_HOMEPAGE\)/, '地址只来自 appLinks 常量并过白名单')
  assert.match(ipc, /\[shell\] openExternal/, '验收按这行日志取证')
  // 自动那条不许把窗口强行拉到前台（会抢焦点）；真正的弹出交给 showMessageBox 自己
  const handler = ipc.slice(ipc.indexOf(`ipcMain.handle('dialog:support'`))
  const body = handler.slice(0, handler.indexOf(`ipcMain.handle('dialog:confirm'`))
  assert.doesNotMatch(body, /win\.(show|focus)\(\)/, '自动提示不许 win.show()/focus() 抢焦点')
})

test('帮助菜单接线：原生菜单与应用内帮助都指向同一条动作', () => {
  const menu = read('src/main/menu.ts')
  assert.match(menu, /\{ label: T\('support'\), click: \(\) => send\('support'\) \}/)
  const top = read('src/renderer/src/components/TopMenuBar.vue')
  assert.match(top, /labelKey: 'menu\.support'/)
  const actions = read('src/renderer/src/composables/useAppActions.ts')
  assert.match(actions, /case 'support':/)
  assert.match(actions, /showSupportPromptManually\(settings\)/)
  // 手动入口永远不写一次性 flag（写 flag 的只有自动那条）
  const lib = read('src/renderer/src/lib/supportPrompt.ts')
  assert.match(lib, /if \(!manual && !result\.manual\)/)
  assert.match(lib, /settings\.set\('supportPromptShown', true\)/)
})

test('三语文案：键齐全、按钮是本轮定稿的措辞、en/ru 无中文残留', () => {
  const expected = {
    'zh-CN': {
      title: '一点小小的说明',
      keepWriting: '知道了',
      starRepo: '去点个 Star'
    },
    'en-US': {
      title: 'A small note from the author',
      keepWriting: 'Got it',
      starRepo: 'Star the project'
    },
    'ru-RU': {
      title: 'Небольшая записка от автора',
      keepWriting: 'Понятно',
      starRepo: 'Поставить звезду'
    }
  }
  for (const lang of LANGS) {
    const s = pack(lang).support
    for (const key of ['title', 'line1', 'line2', 'line3', 'keepWriting', 'starRepo']) {
      assert.equal(typeof s[key], 'string', `${lang}.support.${key} 缺失`)
      assert.ok(s[key].trim().length > 0, `${lang}.support.${key} 为空`)
    }
    assert.equal(s.title, expected[lang].title)
    assert.equal(s.keepWriting, expected[lang].keepWriting)
    if (expected[lang].starRepo) assert.equal(s.starRepo, expected[lang].starRepo)
    // 三语不是同一句话抄三遍（中英正文必须不同）
    assert.notEqual(pack('zh-CN').support.line1, pack('en-US').support.line1)
    if (lang !== 'zh-CN') assert.doesNotMatch(s.line1 + s.line2 + s.line3, /[\u4e00-\u9fff]/)
  }
  assert.match(pack('zh-CN').support.line2, /不勉强，也不用有负担/)
  assert.match(pack('en-US').support.line2, /never expected/)
  assert.match(pack('ru-RU').support.line2, /не обязательно/)
  // 地址唯一来源
  assert.equal(APP_HOMEPAGE, 'https://github.com/yangbaibai-ops/Lumin')
  // 不出现第三方产品名（只允许 Lumin 自己）
  for (const lang of LANGS) {
    const text = Object.values(pack(lang).support).join('\n')
    assert.doesNotMatch(text, /GitHub|Gitee|Patreon|Ko-?fi|Buy Me a Coffee/i)
  }
})
