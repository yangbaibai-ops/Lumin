// 原生菜单的三语自检（静态）。
//
// 为什么用静态检查就够：菜单栏默认被隐藏，页面侧看不到它，运行期只能验证「重建发生了」
// （见 tools/_verify-wave3.js 的 C2）。而「每个标签都真的来自语言包」这件事，读源码最可靠：
//   * 还有没有硬编码中文（非中文用户按 Alt 看到一屏中文就是这个问题）；
//   * `T('key')` 里的 key 有没有在三份语言包里都存在（拼错 key 只会静默回退中文）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const MENU = path.join(ROOT, 'src', 'main', 'menu.ts')
const LOCALES = ['zh-CN', 'en-US', 'ru-RU'].map((l) => ({
  lang: l,
  menu: JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'i18n', `${l}.json`), 'utf-8'))
    .menu
}))

/** 去掉注释（// 与 /* *\/）后的源码；字符串字面量保持原样 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('主进程菜单：没有硬编码中文（全部走语言包）', () => {
  const code = stripComments(fs.readFileSync(MENU, 'utf-8'))
  const cjk = code.match(/[\u4e00-\u9fff]+/g) ?? []
  assert.deepEqual(cjk, [], `menu.ts 里还有硬编码中文：${cjk.join(' / ')}`)
})

test('主进程菜单：T() 用到的 key 在三份语言包里都存在', () => {
  const code = fs.readFileSync(MENU, 'utf-8')
  const keys = [...code.matchAll(/\bT\('([^']+)'\)/g)].map((m) => m[1])
  assert.ok(keys.length >= 30, `取到的 key 太少（${keys.length}），检查提取正则`)
  for (const { lang, menu } of LOCALES) {
    const missing = [...new Set(keys)].filter((k) => typeof menu[k] !== 'string' || !menu[k])
    assert.deepEqual(missing, [], `${lang} 缺少菜单键：${missing.join(', ')}`)
  }
})

test('语言包：顶层菜单名带助记符，条目文案非空', () => {
  for (const { lang, menu } of LOCALES) {
    for (const top of ['file', 'edit', 'view', 'help']) {
      assert.match(menu[top], /\([A-ZА-Я]\)/, `${lang}.menu.${top} 应带 (X) 助记符`)
    }
    for (const [k, v] of Object.entries(menu)) {
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang}.menu.${k} 为空`)
    }
  }
})

test('语言包：三份键集合完全一致（含顶层）', () => {
  const sets = LOCALES.map(({ menu }) => Object.keys(menu).sort().join('|'))
  assert.equal(sets[0], sets[1])
  assert.equal(sets[1], sets[2])
})
