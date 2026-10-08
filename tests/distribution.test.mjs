// ─── 分发链外部输入的判据（报告 §7.4 A）───────────────────────────────────────
//
// 报告点名"缺真实仓库地址 / 官网 / 更新渠道 / 代码签名证书"。代码变不出这些值，能做的是：
//   * 把"哪些是外部输入、现在是什么、缺了会怎样"写成**可判定**的数据（src/shared/distribution.ts）；
//   * 让运行时（updater 判断"要不要真的去查更新"）与构建期（tools/distribution-check.mjs
//     的 --release 门禁）用**同一份**判据，而不是两份各自漂移的占位域名数组；
//   * 把这份清单钉在测试里，免得文档/清单走散。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLACEHOLDER_HOSTS,
  homepageReady,
  isPlaceholderValue,
  repositoryReady,
  signingReady,
  updateChannelReady
} from '../src/shared/distribution.ts'
import {
  collectFacts,
  distributionInputs,
  missingInputs,
  readPublish,
  readRepository,
  renderReport
} from '../tools/distribution-check.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const facts = (over = {}) => ({
  publishProvider: 'generic',
  publishUrl: 'https://dl.example-real.test/lumin',
  publishOwner: '',
  publishRepo: '',
  repository: 'https://github.com/someone/Lumin',
  homepage: 'https://lumin.test',
  isPrivate: true,
  hasSigningCert: true,
  hasSigningPassword: true,
  ...over
})

test('占位判定：空值 / 占位域名 / 模板尖括号都算"没填"，真实地址不算', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(isPlaceholderValue(v), true, String(v))
  assert.equal(isPlaceholderValue('https://example.com/auto-updates'), true)
  assert.equal(isPlaceholderValue('https://EXAMPLE.org/x'), true, '大小写无关')
  assert.equal(isPlaceholderValue('http://localhost:8080/updates'), true)
  assert.equal(isPlaceholderValue('https://github.com/<你的账号>/Lumin'), true, '模板尖括号')
  assert.equal(isPlaceholderValue('https://github.com/yangbaibai/Lumin'), false)
  assert.equal(isPlaceholderValue('https://dl.lumin.app/updates'), false)
  // 清单里每一项都要真的能被识别（否则清单是装饰）
  for (const host of PLACEHOLDER_HOSTS) {
    assert.equal(isPlaceholderValue(`https://${host}/x`), true, host)
  }
})

test('更新渠道就绪判定：generic 看 url，github 看 owner/repo', () => {
  assert.equal(updateChannelReady(facts()), true)
  assert.equal(updateChannelReady(facts({ publishUrl: 'https://example.com/auto-updates' })), false)
  assert.equal(updateChannelReady(facts({ publishProvider: '' })), false, '没有 provider = 没配')
  const gh = { publishProvider: 'github', publishUrl: '', publishOwner: 'me', publishRepo: 'Lumin' }
  assert.equal(updateChannelReady(gh), true)
  assert.equal(updateChannelReady({ ...gh, publishOwner: '<你的账号>' }), false)
  assert.equal(updateChannelReady({ ...gh, publishRepo: '' }), false)
})

test('外部输入清单：五项、id 稳定，private 是有意就绪的那一项', () => {
  const inputs = distributionInputs(facts())
  assert.deepEqual(
    inputs.map((i) => i.id),
    ['update-channel', 'repository', 'homepage', 'private', 'signing-cert']
  )
  assert.equal(inputs.length, 5)
  // 每一项都要有"怎么填"与"缺了会怎样"—— 只说"建议配置"的条目等于没写
  for (const i of inputs) {
    assert.ok(i.how.length > 10, `${i.id} 缺 how`)
    assert.ok(i.missing.length > 10, `${i.id} 缺 missing`)
  }
  assert.deepEqual(missingInputs(inputs), [], '全配好之后待办必须为空')
  // 缺签名证书 → 只有这一项进待办（private 永远不进）
  const todo = missingInputs(distributionInputs(facts({ hasSigningCert: false })))
  assert.deepEqual(
    todo.map((t) => t.id),
    ['signing-cert']
  )
  // 四项判据各自独立（别让一项把另一项的状态带过去）
  assert.equal(repositoryReady(facts({ repository: '' })), false)
  assert.equal(homepageReady(facts({ homepage: '<站点>' })), false)
  assert.equal(signingReady(facts({ hasSigningPassword: false })), false)
  assert.equal(signingReady(facts()), true)
})

test('仓库现状：更新渠道仍是占位、仓库/主页已填、没证书 —— 清单必须如实报出来', () => {
  /**
   * 这条盯的是**真实仓库**（不是构造的事实）。它原本是"缺 repository/homepage"的哨兵，
   * 注释里写着"等仓库地址到手、这几行改完之后它应该变红 —— 那时把断言改成'已就绪'即可"。
   * 现在**地址到手了**（用户给了 GitHub：`https://github.com/yangbaibai-ops/Lumin`，
   * package.json 的 repository/homepage/bugs 都已填），所以这里按设计**转正**：
   * repository/homepage 不再进待办；更新渠道（publish 占位）与签名证书仍是外部输入。
   */
  const f = collectFacts({})
  const inputs = distributionInputs(f)
  const todo = missingInputs(inputs).map((t) => t.id)
  assert.ok(todo.includes('update-channel'), `更新渠道应仍是占位：${JSON.stringify(f)}`)
  assert.ok(
    !todo.includes('repository'),
    `repository 已填（哨兵已转正）：${JSON.stringify({ repository: f.repository })}`
  )
  assert.ok(
    !todo.includes('homepage'),
    `homepage 已填：${JSON.stringify({ homepage: f.homepage })}`
  )
  assert.ok(!todo.includes('private'), 'private=true 是有意的，不该进待办')
})

test('工具与运行时同一份判据：updater 不许再自带一份占位域名数组', () => {
  const updater = read('src/main/services/updater.ts')
  assert.match(updater, /from '\.\.\/\.\.\/shared\/distribution'/, 'updater 必须用 shared 的判据')
  assert.doesNotMatch(updater, /PLACEHOLDER_HOSTS\s*=\s*\[/, '不许在 updater 里再抄一份清单')
  assert.match(updater, /isPlaceholderValue\(/, '判据要走共享实现')
})

test('打包配置：更新包签名校验开着（在 win 段！）、卸载不删用户数据、publish 解析得出', () => {
  const yml = read('electron-builder.yml')
  const parsed = readPublish(yml)
  assert.equal(parsed.provider, 'generic')
  assert.equal(parsed.url, 'https://example.com/auto-updates')
  assert.equal(isPlaceholderValue(parsed.url), true, '当前就该是占位（发版前要换掉）')
  /**
   * ⚠️ `verifyUpdateCodeSignature` 属于 **win** 段（scheme.json 的
   * WindowsConfiguration.properties），**不在 nsis 段** —— 放错位置会被 electron-builder 的
   * schema 校验直接拒掉**整个配置**，而报错只有一句 `configuration.nsis should be null`（极难定位，
   * 本轮实测踩过）。所以这条不只断言"文件里出现过这个键"，还钉住它**在哪个段里**。
   */
  const winBlock = yml.slice(yml.indexOf('\nwin:'), yml.indexOf('\nportable:'))
  const nsisBlock = yml.slice(yml.indexOf('\nnsis:'))
  assert.match(
    winBlock,
    /^\s*verifyUpdateCodeSignature:\s*true\s*$/m,
    'win 段必须显式钉住更新包签名校验'
  )
  assert.doesNotMatch(
    nsisBlock,
    /verifyUpdateCodeSignature/,
    '它不属于 nsis 段（放进去整个配置会被拒）'
  )
  // 卸载绝不删用户数据（笔记索引/草稿/设置都在那里）
  assert.match(yml, /^\s*deleteAppDataOnUninstall:\s*false\s*$/m)
  // 签名靠环境变量开关，配置里不许出现 ${env.CSC_*} 那种"没设就崩"的插值
  assert.doesNotMatch(
    yml,
    /\$\{env\.(?:WIN_)?CSC_/,
    '签名开关靠 electron-builder 的自动识别，不用 env 插值'
  )
})

test('工具可被导入、渲染出的表里既有当前值也有待办说明', () => {
  assert.equal(readRepository({ repository: 'https://x.test/a' }), 'https://x.test/a')
  assert.equal(
    readRepository({ repository: { type: 'git', url: 'https://x.test/b' } }),
    'https://x.test/b'
  )
  assert.equal(readRepository({}), '')
  const text = renderReport(distributionInputs(facts({ homepage: '' })))
  assert.match(text, /homepage/)
  assert.match(text, /待办 1 项/)
  assert.match(text, /缺了会怎样/)
  const clean = renderReport(distributionInputs(facts()))
  assert.match(clean, /外部输入已齐/)
})
