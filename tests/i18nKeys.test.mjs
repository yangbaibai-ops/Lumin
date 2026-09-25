// 语言包的每个键都必须**真的被用到**（静态）。
//
// 审计 §10：三份包共 422 键，其中约 55 个是"真空键"（写好了却没有任何界面在用）。
// 这类键的危害不是占空间，而是**让"功能清单"看起来比实际多**：README 与手册会照着
// 键名以为某个设置项存在（`settings.reset` 甚至对应一个 store 里存在、界面里却
// 够不到的 `reset()`）。所以这里把"死键"变成红灯：
//
//   * 每个键都必须在 `src/**` 里以**带引号的字面量**出现（`t('a.b')` / `labelKey: 'a.b'` /
//     `mainT('menu.newWindow')` …）；
//   * `menu.*` 允许用短键引用 —— 主进程 `menu.ts` 写的是 `T('file')`（前缀在代码里补），
//     这是刻意的（菜单项多、写全键太吵）；
//   * 真要有"留作占位"的键，必须登记进下面的 `RESERVED` 并写明理由（当前为空）。
//
// 与 `i18nHardcoded.test.mjs` 是一对：那条管"界面文案有没有绕过语言包"，
// 这条管"语言包有没有凭空长出没人用的键"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenize } from './lib/hardcodedTextScan.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LANGS = ['zh-CN', 'en-US', 'ru-RU']

/** 允许"存在但暂未引用"的键：`键 → 理由`（应为空；加进来就等于承认欠债） */
const RESERVED = {
  'menu.homepage':
    '原生菜单的「打开项目主页」入口**故意注释着**：仓库还没有真实可公开的地址（package.json 的 homepage/repository 也是空的），见 src/main/menu.ts 的说明与清单 §5/§7 的外部阻塞项。地址一落就能直接启用。'
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|vue|mjs|js)$/.test(entry.name)) out.push(p)
  }
  return out
}

// 只留"代码 + 字面量"，**注释剥掉** —— 否则注释里写一句 `见 settings.reset`
// 就能让一个没人用的键"看起来被引用了"（那正是这条测试要防的事）。
const SRC_TEXT = walk(join(ROOT, 'src'))
  .map((f) =>
    tokenize(readFileSync(f, 'utf-8'))
      .filter((t) => t.kind !== 'comment')
      .map((t) => t.text)
      .join('\n')
  )
  .join('\n')

/** 扁平化语言包：`a.b.c → 值` */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = v
  }
  return out
}

const packs = LANGS.map((lang) => ({
  lang,
  flat: flatten(
    JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8'))
  )
}))

/** 这个键在 src 里出现过吗（带引号；menu.* 允许短键） */
function isReferenced(key) {
  const full = [`'${key}'`, `"${key}"`, `\`${key}\``]
  if (full.some((q) => SRC_TEXT.includes(q))) return true
  if (key.startsWith('menu.')) {
    const short = key.slice('menu.'.length)
    return [`'${short}'`, `"${short}"`, `\`${short}\``].some((q) => SRC_TEXT.includes(q))
  }
  return false
}

test('语言包：三份键集合一致（这条是下面两条的前提）', () => {
  const [a, b, c] = packs.map((p) => Object.keys(p.flat).sort().join('|'))
  assert.equal(a, b)
  assert.equal(b, c)
})

test('语言包：没有零引用的死键（有就删掉或登记进 RESERVED）', () => {
  const dead = Object.keys(packs[0].flat).filter((k) => !isReferenced(k) && !(k in RESERVED))
  assert.deepEqual(
    dead,
    [],
    `以下键在三份语言包里都存在，但 src 里没有任何地方引用：\n${dead.join('\n')}`
  )
})

test('RESERVED 里的键必须真的存在（占位也不是随便写的）', () => {
  const all = new Set(Object.keys(packs[0].flat))
  const ghost = Object.keys(RESERVED).filter((k) => !all.has(k))
  assert.deepEqual(ghost, [], `RESERVED 里登记了不存在的键：${ghost.join(', ')}`)
})

test('语言包：非空串 + en/ru 无中日韩残留（排除项，防回退）', () => {
  for (const { lang, flat } of packs) {
    const empty = Object.entries(flat).filter(([, v]) => typeof v !== 'string' || !v.trim())
    assert.deepEqual(
      empty.map(([k]) => k),
      [],
      `${lang} 有空值键`
    )
    if (lang !== 'zh-CN') {
      const cjk = Object.entries(flat).filter(([, v]) => /[\u4e00-\u9fff]/.test(v))
      assert.deepEqual(
        cjk.map(([k]) => k),
        [],
        `${lang} 里有中文残留`
      )
    }
  }
})
