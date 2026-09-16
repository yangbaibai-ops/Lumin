// 结构面静态守卫：i18n 三语完整性与 IPC 通道接线。
//
// 为什么值得放进 `npm run ci`：这两类问题**运行时不一定报错**，但一定会伤到人 ——
//   * i18n：某个语言少一个 key → 界面上直接显示 key 名或回落到英文（用户看到半截翻译）；
//   * IPC：preload 调了一个主进程没注册的通道 → 该功能静默失效（Promise 永不 resolve）；
//     主进程注册了但没人调的通道 → 死代码（改动时容易被误认为「在用」）。
// 两者都能**静态**查清，成本毫秒级，所以没有理由等运行时才发现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const LOCALE_DIR = path.join(ROOT, 'src', 'shared', 'i18n')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

const flatKeys = (o, prefix = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flatKeys(v, prefix + k + '.') : [prefix + k]
  )
const getPath = (o, key) => key.split('.').reduce((a, p) => (a == null ? a : a[p]), o)

test('i18n：三种语言 key 集合完全一致（少一个 key 就会在界面上露馅）', () => {
  const files = fs.readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'))
  assert.ok(files.length >= 3, `语言包只有 ${files.length} 个`)
  const sets = {}
  for (const f of files)
    sets[f] = new Set(flatKeys(JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf-8'))))
  const base = files[0]
  const problems = []
  for (const f of files.slice(1)) {
    const missing = [...sets[base]].filter((k) => !sets[f].has(k))
    const extra = [...sets[f]].filter((k) => !sets[base].has(k))
    if (missing.length)
      problems.push(`${f} 缺 ${missing.length} 个：${missing.slice(0, 8).join(', ')}`)
    if (extra.length) problems.push(`${f} 多 ${extra.length} 个：${extra.slice(0, 8).join(', ')}`)
  }
  assert.deepEqual(problems, [])
})

test('i18n：非中文语言里不该残留纯中文文案（漏翻译）', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf-8'))
  const zh = read('zh-CN.json')
  const offenders = []
  for (const f of ['en-US.json', 'ru-RU.json']) {
    const other = read(f)
    for (const key of flatKeys(zh)) {
      const a = getPath(zh, key)
      const b = getPath(other, key)
      if (typeof a !== 'string' || typeof b !== 'string') continue
      // 值里含 CJK 就算漏翻译（纯符号/命令/品牌名如 `Ctrl+S`、`Lumin` 不含 CJK）
      if (/[\u4e00-\u9fff]/.test(b) && a === b) offenders.push(`${f}:${key}=${b}`)
    }
  }
  assert.deepEqual(offenders, [], 'en-US / ru-RU 里出现了与中文一模一样的文案')
})

test('i18n：代码里用到的 key 都在语言包里（否则界面显示 key 名）', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'zh-CN.json'), 'utf-8'))
  const keys = new Set(flatKeys(zh))
  const files = [
    ...walk(path.join(ROOT, 'src', 'renderer')),
    ...walk(path.join(ROOT, 'src', 'main'))
  ]
  const missing = new Set()
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8')
    // 只认字面量 key：`t('a.b')` / `$t("a.b")` / `tm('a.b')`；模板拼接与变量不参与（无法静态判定）
    for (const m of text.matchAll(/\$?\b(?:t|tm)\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
      const key = m[1]
      if (!key.includes('.')) continue
      if (!keys.has(key)) missing.add(key)
    }
    // 主进程菜单用 MenuLabels 结构体而不是 t()，这里只兜住渲染层的字面量
  }
  assert.deepEqual([...missing].sort(), [], '代码里用了语言包里没有的 key')
})

test('IPC：preload 调用的通道主进程都注册了，且没有重复注册', () => {
  const files = [
    ...walk(path.join(ROOT, 'src', 'main')),
    ...walk(path.join(ROOT, 'src', 'preload'))
  ]
  const handlers = new Map()
  const invokes = new Map()
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8')
    for (const m of text.matchAll(/ipcMain\.(?:handle|on)\(\s*['"`]([^'"`]+)['"`]/g)) {
      handlers.set(m[1], (handlers.get(m[1]) ?? 0) + 1)
    }
    for (const m of text.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"`]([^'"`]+)['"`]/g)) {
      invokes.set(m[1], (invokes.get(m[1]) ?? 0) + 1)
    }
  }
  assert.ok(handlers.size > 40, `只扫到 ${handlers.size} 个 IPC 通道，路径可能不对`)
  const orphanCalls = [...invokes.keys()].filter((c) => !handlers.has(c)).sort()
  assert.deepEqual(orphanCalls, [], 'preload 调了主进程没注册的通道 → 该功能会静默挂起')
  const dup = [...handlers.entries()].filter(([, n]) => n > 1)
  assert.deepEqual(dup, [], '同一个通道被注册多次')
})

test('IPC：主进程注册但没人调的通道必须登记原因（死通道容易被误当成「在用」）', () => {
  const files = [
    ...walk(path.join(ROOT, 'src', 'main')),
    ...walk(path.join(ROOT, 'src', 'preload'))
  ]
  const handlers = new Set()
  const invokes = new Set()
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8')
    for (const m of text.matchAll(/ipcMain\.(?:handle|on)\(\s*['"`]([^'"`]+)['"`]/g))
      handlers.add(m[1])
    for (const m of text.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"`]([^'"`]+)['"`]/g))
      invokes.add(m[1])
  }
  /**
   * 已知死通道（登记在案，不是「允许随便加」）：
   * `file:getPathForFile` —— 主进程注册了它，但 preload 里用的是 `webUtils.getPathForFile`
   * 直连（拖放取真实路径走的是 Electron 的同步 API，根本不需要 IPC 往返），
   * 渲染层调的 `window.luminAPI.file.getPathForFile` 命中的是 preload 那份实现。
   * 结论：主进程那段是死代码，建议删；删之前在这里留一条记录，免得后来人以为它在用。
   */
  const KNOWN_DEAD = new Set(['file:getPathForFile'])
  const dead = [...handlers].filter((c) => !invokes.has(c) && !KNOWN_DEAD.has(c)).sort()
  assert.deepEqual(dead, [], '这些通道注册了但没人调用：请删除，或在 KNOWN_DEAD 里写明原因')
})
