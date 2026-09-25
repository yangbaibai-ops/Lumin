// Electron 版本与升级评估文档必须对得上（审计 §5 P0「Electron 39 已 EOL」）。
//
// 这条**不会**因为"Electron 已 EOL"而红 —— 那不是一段代码能修的（升级要单独分支 +
// 完整矩阵，见 docs/electron-upgrade.md §3/§4）。它守的是另一件同样重要的事：
// **文档里的版本事实不能悄悄过期**。升级完成后忘了改文档，这条会立刻报出来；
// 而"文档说 39、实际跑 44"正是最误导人的那种状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')

const installedVersion = (() => {
  const f = path.join(ROOT, 'node_modules', 'electron', 'dist', 'version')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim() : null
})()

const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  .devDependencies.electron

test('Electron：package.json 的声明与实装版本都能读到', () => {
  assert.ok(declared, 'package.json 里应有 electron 依赖')
  assert.ok(
    installedVersion,
    '读不到 node_modules/electron/dist/version —— 先 npm ci（这条测试在只装了部分依赖的机器上会红，是刻意的）'
  )
  assert.match(installedVersion, /^\d+\.\d+\.\d+/, `实装版本不像版本号：${installedVersion}`)
})

test('Electron：升级评估文档记录的实装版本必须与 node_modules 一致', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'electron-upgrade.md'), 'utf-8')
  assert.ok(
    doc.includes(`\`${installedVersion}\``),
    `docs/electron-upgrade.md 里应记录实装版本 \`${installedVersion}\`（升级后请同步文档的"现状"表）`
  )
  assert.ok(
    doc.includes(`\`"electron": "${declared}"\``) || doc.includes(declared),
    `文档里应记录 package.json 的声明 \`${declared}\``
  )
})

test('Electron：主版本被 ^ 锁死这件事在文档里有交代', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'electron-upgrade.md'), 'utf-8')
  const major = Number(installedVersion.split('.')[0])
  assert.match(
    doc,
    new RegExp(`\\^${major}\\.`),
    '文档应写明 `^<major>.` 这种范围永远升不到下一个主版本（否则读者会以为 npm update 能解决）'
  )
})
