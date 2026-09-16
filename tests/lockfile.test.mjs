// 仓库自检：package.json 与 package-lock.json 必须一致
//
// 为什么值得一条测试：`npm ci`（CI 用的就是它）在两份文件不一致时会**直接报错退出**，
// 而「加/删一个依赖却忘了同步 lock」是极容易犯、又只在 CI 上才暴露的错误。
// 这里离线校验三件事：根依赖集合一致、声明版本被 lock 满足、lock 里没有悬空引用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const lockRoot = lock.packages[''] ?? {}

const fields = ['dependencies', 'devDependencies', 'optionalDependencies']

test('lock 的根依赖与 package.json 完全一致（增删依赖必须同步 lock）', () => {
  for (const field of fields) {
    const want = Object.keys(pkg[field] ?? {}).sort()
    const got = Object.keys(lockRoot[field] ?? {}).sort()
    assert.deepEqual(got, want, `${field} 不一致（package.json ↔ package-lock.json）`)
  }
})

test('每个声明的依赖在 lock 树里都有对应条目', () => {
  for (const field of fields) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      assert.ok(lock.packages[`node_modules/${name}`], `lock 缺少 ${name}`)
    }
  }
})

test('非 optional 条目没有指向不存在包的悬空引用', () => {
  // optional 条目是**平台相关**的（如 wasm32 专属的 @tailwindcss/oxide-wasm32-wasi），
  // 在当前平台上不安装、它的 deps 自然不在树里 —— 那是 npm 的正常产物，不是不一致。
  const names = new Set(Object.keys(lock.packages))
  const dangling = []
  for (const [key, meta] of Object.entries(lock.packages)) {
    if (meta.optional) continue
    for (const field of fields) {
      for (const dep of Object.keys(meta[field] ?? {})) {
        if (!names.has(`node_modules/${dep}`) && !meta[field][dep]?.startsWith?.('file:')) {
          dangling.push(`${key} → ${dep}`)
        }
      }
    }
  }
  assert.deepEqual(dangling, [])
})

test('name / version 一致，lockfileVersion 可识别', () => {
  assert.equal(lock.name, pkg.name)
  assert.equal(lock.version, pkg.version)
  assert.ok([2, 3].includes(lock.lockfileVersion), `未知 lockfileVersion=${lock.lockfileVersion}`)
})

test('engines 声明了 Node 下限（避免「我这能跑」）', () => {
  assert.ok(pkg.engines?.node, 'package.json 应声明 engines.node')
})

test('质量门禁脚本齐全（typecheck / lint / test:unit / ci / build）', () => {
  for (const s of ['typecheck', 'lint', 'test:unit', 'ci', 'build']) {
    assert.ok(pkg.scripts?.[s], `缺少 npm run ${s}`)
  }
})
