// ─── 叠放层级（z-index）令牌：顺序不变量 + 不留字面量（审计 §8 P2「z-index 也是散的」）──
//
// 为什么值得一条单测：浮层顺序错了不会报错、也不会红，
// 只会表现成"这个框被那个框盖住了"——而且只在特定的组合下出现（比如"草稿弹窗 + 右键菜单"）。
// 审计的现场是 17 处模板字面量 + 5 处 CSS 字面量，谁压谁只能靠 grep 拼。
// 现在令牌是唯一真相源（`theme.css` 的 `:root` 块），这里守四件事：
//   ① 每一档都真的定义在 `:root` 里、是整数；
//   ② **文档化的顺序严格递增**（tooltip < popover < page < search < modal < critical < editorMenu < global tooltip）；
//   ③ 模板与分片 CSS 里**不许再出现数字字面量**（注释不算——注释是文档）；
//   ④ 用到的 `var(--z-*)` 都必须有出处。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(ROOT, 'src/renderer/src/assets')
const read = (p) => fs.readFileSync(p, 'utf-8')

/**
 * 从下到上的**完整顺序**（同一条链上的每一档都必须严格更大）。
 * 这份顺序就是"谁压在谁上面"的规格：改数字必须同时改这里的意图。
 * `--z-raise`（树导轨那类局部叠放）不参与浮层比较，所以单独放最前面只做存在性检查。
 */
const LOCAL = ['--z-raise']
const STACK = [
  '--z-grip', // 拖拽手柄 / 分隔条
  '--z-chip', // 编辑器内的小胶囊
  '--z-dialog', // 本地历史浮层
  '--z-tooltip', // 编辑器内的 title 替身
  '--z-popover', // 工具栏气泡
  '--z-page', // 整页设置 / 侧栏最近下拉
  '--z-search', // 全局搜索
  '--z-modal', // 模态 / 顶栏一级菜单
  '--z-modal-sub', // 模态上的二级菜单
  '--z-critical', // 草稿弹窗 / 右键菜单
  '--z-critical-sub', // 右键二级
  '--z-editor-menu', // 编辑器右键菜单
  '--z-editor-menu-sub', // 编辑器右键二级
  '--z-tooltip-global' // 全局 tooltip：压在所有东西之上
]
const ORDER = [...LOCAL, ...STACK]

/** 取出 `:root { … }` 里那份主题无关的 z 令牌表（注释先剥掉） */
function zTokens() {
  const css = read(path.join(ASSETS, 'theme.css')).replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1])
  const out = {}
  for (const body of blocks) {
    for (const m of body.matchAll(/(--z-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = Number(m[2].trim())
  }
  return out
}

/** 遍历 src 下的文本文件（跳过 assets，调用方按需处理） */
function srcFiles(exts) {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (exts.some((x) => e.name.endsWith(x))) out.push(f)
    }
  }
  walk(path.join(ROOT, 'src'))
  return out
}

test('z 令牌：每一档都定义在 :root 里，且是整数', () => {
  const tokens = zTokens()
  for (const name of ORDER) {
    assert.ok(name in tokens, `${name} 没定义（新增浮层请在 theme.css 的 :root 里加档）`)
    assert.ok(Number.isInteger(tokens[name]), `${name} 必须是整数，实际 ${tokens[name]}`)
  }
})

test('z 令牌：文档化的顺序严格递增（谁压在谁上面是规格，不是巧合）', () => {
  const tokens = zTokens()
  for (let i = 1; i < STACK.length; i++) {
    const prev = STACK[i - 1]
    const cur = STACK[i]
    assert.ok(
      tokens[cur] > tokens[prev],
      `${cur}(${tokens[cur]}) 必须严格大于 ${prev}(${tokens[prev]})——浮层顺序表见 theme.css`
    )
  }
})

test('模板里不许再出现数字 z-index（必须走令牌）', () => {
  /**
   * 口径：**全局浮层**（会互相遮挡的那些）必须走 `--z-*` 令牌，**命名数字档也一样**。
   *
   * 报告 §5.1 的复核结论：这条守卫原来只拦 `z-[数字]` 与 `zIndex: 数字`，于是 Tailwind 的
   * 命名数字档（`z-10` / `z-50`）从缝里溜了过去 —— `StatusBar` 的 `⋯` 浮层就是 `z-50`，
   * 比 `--z-dialog(70)` / `--z-page(120)` 都低：本地历史浮层一开就能把它压住。
   * 现在命名档也拦，只留**一处**显式豁免（Settings 页的吸顶小标题栏，它只在自己那一层里比大小，
   * 不参与全局顺序 —— 用全局令牌反而会让人误以为它在浮层链上）。
   */
  const ALLOW = new Set(['src/renderer/src/components/SettingsDialog.vue'])
  const offenders = []
  for (const f of srcFiles(['.vue', '.ts'])) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    const text = read(f)
    for (const m of text.matchAll(/z-\[(\d+)\]/g)) {
      offenders.push(`${rel} → z-[${m[1]}]`)
    }
    // 内联 style 里写死 z-index 也算
    for (const m of text.matchAll(/zIndex:\s*(\d+)/g)) {
      offenders.push(`${rel} → zIndex: ${m[1]}`)
    }
    // Tailwind 命名数字档（z-0 / z-10 / … / z-50）—— 豁免名单之外一律算违规
    if (!ALLOW.has(rel)) {
      for (const m of text.matchAll(/(?<![\w-])z-(\d{1,2})(?![\w-])/g)) {
        offenders.push(`${rel} → z-${m[1]}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `这些地方还在写死层级：\n${offenders.join('\n')}`)
})

test('分片 CSS 里不许再出现数字 z-index（注释里的说明不算）', () => {
  const offenders = []
  for (const f of fs.readdirSync(ASSETS).filter((x) => x.endsWith('.css'))) {
    const code = read(path.join(ASSETS, f)).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of code.matchAll(/z-index:\s*([^;]+);/g)) {
      const v = m[1].trim()
      if (!v.startsWith('var(--z-')) offenders.push(`${f} → z-index: ${v}`)
    }
  }
  assert.deepEqual(offenders, [], `这些地方还在写死层级：\n${offenders.join('\n')}`)
})

test('用到的 var(--z-*) 都必须有出处（拼错就红）', () => {
  const defined = new Set(Object.keys(zTokens()))
  const dangling = new Set()
  /** 注释里可能出现"示例写法"（比如 theme.css 的用法说明），先把注释剥掉 */
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const scan = (text, label) => {
    for (const m of strip(text).matchAll(/var\((--z-[\w-]+)/g)) {
      if (!defined.has(m[1])) dangling.add(`${label} → ${m[1]}`)
    }
  }
  for (const f of srcFiles(['.vue', '.ts'])) scan(read(f), path.relative(ROOT, f))
  for (const f of fs.readdirSync(ASSETS).filter((x) => x.endsWith('.css'))) {
    scan(read(path.join(ASSETS, f)), f)
  }
  assert.deepEqual([...dangling], [], `这些 z 令牌没有定义：${[...dangling].join(', ')}`)
})

test('z 令牌是主题无关的：三个主题块里都不该出现（否则会破坏主题令牌集合一致性）', () => {
  const css = read(path.join(ASSETS, 'theme.css')).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(/\.theme-\w+\s*\{([^}]*)\}/g)) {
    assert.equal(
      /--z-/.test(m[1]),
      false,
      '主题块里出现了 z 令牌：它应该只在那段 :root 里（主题块只放颜色）'
    )
  }
})
