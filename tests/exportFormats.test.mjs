// ─── 导出格式清单：唯一数据源 + 各处派生（审计 §6 P2「格式清单存在 5 处」）──────────
//
// 审计的现场：加一种导出格式要动 8~10 个文件，而"格式清单"本身在 5 处各写一遍
// （原生菜单 / 快捷键表 / 设置页那张表 / 命令分发 / IPC 发送）——漏一处的表现是
// **静默少一个入口**。现在清单收在 `shared/exportFormats.ts`，这里守三件事：
//   ① 清单自身自洽（id 唯一、类型联合一致、键位/品牌名/图标都在）；
//   ② 每个格式的**两个语言包键**（菜单名 + 设置页说明）在三种语言里都存在且非空；
//   ③ 每个格式在 **preload 与主进程 ipc** 里都真的有通道；并且那些"曾经各写一遍"的地方
//      现在**不再出现字面量**（否则这次收敛会在下一次改动里悄悄退化）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORT_FORMATS, exportFormatByAction } from '../src/shared/exportFormats.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

test('清单自洽：id 唯一、命令名与菜单动作名唯一、品牌名/图标都在', () => {
  const ids = EXPORT_FORMATS.map((f) => f.id)
  assert.deepEqual(
    ids,
    ['pdf', 'html', 'word', 'epub'],
    '格式集合变了就要同步 shared/types 的联合类型'
  )
  // 命令名 / 动作名 / i18n 键必须唯一；brand 与 icon 只要求非空
  //（PDF 与 Word 共用 `file` 图标是有意的：图标表里没有 .doc 那个字形）
  for (const key of ['commandId', 'menuAction', 'labelKey', 'descKey']) {
    const values = EXPORT_FORMATS.map((f) => f[key])
    assert.equal(new Set(values).size, values.length, `${key} 有重复：${values.join(', ')}`)
  }
  for (const key of ['commandId', 'menuAction', 'labelKey', 'descKey', 'brand', 'icon']) {
    const values = EXPORT_FORMATS.map((f) => f[key])
    assert.ok(
      values.every((v) => typeof v === 'string' && v.length > 0),
      `${key} 有空值`
    )
  }
  // 默认键位：目前只有 pdf 出厂绑了键（用户可在设置里改）
  assert.equal(EXPORT_FORMATS.filter((f) => f.defaultKeys !== null).length, 1)
})

test('清单与 shared/types 的 ExportFormat 联合类型一致', () => {
  const src = read('src/shared/types.ts')
  const m = /export type ExportFormat =([^\n]+)/.exec(src)
  assert.ok(m, 'shared/types.ts 里找不到 ExportFormat 的联合类型')
  const declared = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort()
  assert.deepEqual(declared, EXPORT_FORMATS.map((f) => f.id).sort())
})

test('每个格式的菜单名与设置页说明在三种语言里都存在且非空', () => {
  const langs = ['zh-CN', 'en-US', 'ru-RU']
  const packs = Object.fromEntries(
    langs.map((l) => [l, JSON.parse(read(`src/shared/i18n/${l}.json`))])
  )
  const pick = (pack, key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), pack)
  for (const f of EXPORT_FORMATS) {
    for (const key of [f.labelKey, f.descKey]) {
      for (const l of langs) {
        const v = pick(packs[l], key)
        assert.equal(typeof v, 'string', `${l} 缺 ${key}（${f.id}）`)
        assert.ok(v.trim().length > 0, `${l} 的 ${key} 是空串`)
      }
    }
  }
})

test('每个格式在 preload 与主进程 ipc 里都有通道（漏一处 = 那个格式点了没反应）', () => {
  const preload = read('src/preload/index.ts')
  const ipc = read('src/main/ipc.ts')
  for (const f of EXPORT_FORMATS) {
    assert.match(preload, new RegExp(`\\b${f.id}\\s*:`), `preload 里没有 export.${f.id} 通道`)
    assert.ok(ipc.includes(`'export:${f.id}'`), `main/ipc.ts 里没有 'export:${f.id}' handler`)
  }
})

test('曾经各写一遍的六处现在从清单派生（不许再出现字面量）', () => {
  // 原生菜单：子项由 EXPORT_FORMATS.map 生成，不该再有 `send('export-pdf')`
  const menu = read('src/main/menu.ts')
  assert.match(menu, /EXPORT_FORMATS\.map/)
  for (const f of EXPORT_FORMATS) {
    assert.equal(menu.includes(`'${f.menuAction}'`), false, `menu.ts 又写死了 ${f.menuAction}`)
  }
  // 快捷键表：四条命令由同一个 map 生成
  const keymap = read('src/renderer/src/composables/useKeymap.ts')
  assert.match(keymap, /EXPORT_FORMATS\.map/)
  for (const f of EXPORT_FORMATS) {
    assert.equal(keymap.includes(`'${f.commandId}'`), false, `useKeymap.ts 又写死了 ${f.commandId}`)
  }
  // 命令分发：走 exportFormatByAction 查表，不再一条一个 case
  const actions = read('src/renderer/src/composables/useAppActions.ts')
  assert.match(actions, /exportFormatByAction\(/)
  for (const f of EXPORT_FORMATS) {
    assert.equal(
      actions.includes(`case '${f.menuAction}'`),
      false,
      `useAppActions 又写死了 ${f.menuAction}`
    )
  }
  // 应用内菜单（TopMenuBar）的导出二级项同样派生
  const topMenu = read('src/renderer/src/components/TopMenuBar.vue')
  assert.match(topMenu, /EXPORT_FORMATS\.map/)
  for (const f of EXPORT_FORMATS) {
    assert.equal(
      topMenu.includes(`runExport('${f.id}')`),
      false,
      `TopMenuBar.vue 又写死了 runExport('${f.id}')`
    )
  }
  // 设置页那张表：brand/icon/desc 都来自清单
  const settings = read('src/renderer/src/components/SettingsDialog.vue')
  assert.match(settings, /EXPORT_FORMATS\.map/)
  for (const f of EXPORT_FORMATS) {
    assert.equal(
      settings.includes(`'${f.brand}'`),
      false,
      `SettingsDialog 又写死了品牌名 ${f.brand}`
    )
  }
})

test('exportFormatByAction：命中返回格式，未命中返回 null（非导出命令走各自的 case）', () => {
  for (const f of EXPORT_FORMATS) {
    assert.equal(exportFormatByAction(f.menuAction)?.id, f.id)
  }
  assert.equal(exportFormatByAction('save'), null)
  assert.equal(exportFormatByAction('export-docx'), null)
})
