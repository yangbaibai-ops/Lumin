#!/usr/bin/env node
// ─── 分发链外部输入自检（报告 §7.4 A）──────────────────────────────────────────
//
// 报告点名这一块"缺真实仓库地址 / 官网 / 更新渠道 / 代码签名证书"。这些东西**代码变不出来**：
// 仓库地址与证书只有作者有。所以这里做三件事，让"拿到就能填"变成一句可执行的话：
//   1. 把当前值读出来（electron-builder.yml 的 publish、package.json 的 repository/homepage、
//      环境变量里的签名凭据）；
//   2. 用 `src/shared/distribution.ts` 的判据（**与运行时 updater 同一份**）算出哪些还没配，
//      打印成一张带"改哪里 / 缺了会怎样"的表；
//   3. 开发态只提示（exit 0），`--release` 时缺任何一项就 **exit 1** —— 免得带着 example.com
//      的更新地址发出去。
//
// 用法：
//   node tools/distribution-check.mjs            # 人看：现状 + 待办
//   node tools/distribution-check.mjs --release  # 发布门禁：缺项即失败
//   node tools/distribution-check.mjs --json     # 机器看（CI 里存档）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  homepageReady,
  isPlaceholderValue,
  repositoryReady,
  signingReady,
  updateChannelReady
} from '../src/shared/distribution.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const release = args.includes('--release')

/**
 * 外部输入清单（**文案在这里，判据在 shared/distribution.ts**）。
 * 为什么文案不放 shared：那是给开发者看的构建期产物，而 `src/**` 里的中文一律要求走语言包
 * （见 tests/i18nHardcoded.test.mjs）；工具输出中文是这个仓库的既有约定（run-suites/doc-facts 都是）。
 */
export function distributionInputs(f) {
  return [
    {
      id: 'update-channel',
      label: '更新渠道（publish）',
      value:
        f.publishProvider.toLowerCase() === 'github'
          ? `${f.publishOwner}/${f.publishRepo}`.replace(/^\/|\/$/g, '')
          : f.publishUrl,
      how: 'electron-builder.yml 的 publish：generic 填 url、github 填 owner/repo；重打包后会把渠道写进 app-update.yml',
      missing: '占位地址会被 updater 识别并**跳过检查**（用户永远收不到更新，且不会有任何提示）',
      ready: updateChannelReady(f)
    },
    {
      id: 'repository',
      label: '仓库地址（repository）',
      value: f.repository,
      how: 'package.json 加 "repository": "https://github.com/<账号>/Lumin"（或 {"type":"git","url":"…"}）',
      missing: 'README/关于页指向不了源码；用户与工具都找不到项目主页',
      ready: repositoryReady(f)
    },
    {
      id: 'homepage',
      label: '官网/下载页（homepage）',
      value: f.homepage,
      how: 'package.json 加 "homepage": "https://<站点>/lumin"',
      missing: '「关于」与错误报告入口没有可点的落地页，用户拿到安装包后不知道该去哪',
      ready: homepageReady(f)
    },
    {
      id: 'private',
      label: 'package.json private',
      value: f.isPrivate ? 'true' : 'false',
      how: '保持 true（Lumin 不发 npm）；只在确实要 publish 到 npm 时才改 false',
      missing: '（这一项是**有意**的：private=true 能挡住误发 npm；脚本只把它报出来让人确认）',
      ready: f.isPrivate
    },
    {
      id: 'signing-cert',
      label: 'Windows 代码签名证书',
      value: f.hasSigningCert ? '已检测到 CSC_LINK / WIN_CSC_LINK' : '',
      how: '设环境变量 CSC_LINK（.pfx 路径或 base64）+ CSC_KEY_PASSWORD，然后 npm run build:win —— electron-builder 会自动签名，无需改配置',
      missing:
        '产出的安装包未签名 ⇒ 用户首次运行会看到 SmartScreen「未知发布者」警告，企业环境可能直接拦住',
      ready: signingReady(f)
    }
  ]
}

/** 未就绪的项（脚本据它决定成败；`private` 那项有意就绪，不会出现在这里） */
export function missingInputs(inputs) {
  return inputs.filter((i) => !i.ready)
}

/** 从 electron-builder.yml 里读 publish 段（只有一个 provider/url/owner/repo，不引入 YAML 依赖） */
export function readPublish(ymlText) {
  const out = { provider: '', url: '', owner: '', repo: '' }
  // 只看 publish: 之后到下一个顶层键（顶格的非空行）之间的内容
  const lines = ymlText.split(/\r?\n/)
  let inPublish = false
  for (const line of lines) {
    if (/^publish:\s*$/.test(line)) {
      inPublish = true
      continue
    }
    if (inPublish && /^[A-Za-z]/.test(line)) break // 下一个顶层键
    if (!inPublish) continue
    const m = /^\s+(provider|url|owner|repo):\s*(.+?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** package.json 的 repository 既可能是字符串也可能是 {url} —— 都收敛成字符串 */
export function readRepository(pkg) {
  const r = pkg.repository
  if (!r) return ''
  if (typeof r === 'string') return r
  return typeof r.url === 'string' ? r.url : ''
}

/** 收集事实（唯一的 I/O 都在这一个函数里，便于测试注入） */
export function collectFacts(env = process.env) {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf-8')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const publish = readPublish(yml)
  const link = env.CSC_LINK || env.WIN_CSC_LINK || ''
  const password = env.CSC_KEY_PASSWORD || env.WIN_CSC_KEY_PASSWORD || ''
  return {
    publishProvider: publish.provider,
    publishUrl: publish.url,
    publishOwner: publish.owner,
    publishRepo: publish.repo,
    repository: readRepository(pkg),
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : '',
    isPrivate: pkg.private === true,
    hasSigningCert: !isPlaceholderValue(link),
    hasSigningPassword: !isPlaceholderValue(password)
  }
}

/** 渲染成人看的表（列宽按内容算，避免手写空格漂移） */
export function renderReport(inputs) {
  const rows = inputs.map((i) => ({
    state: i.ready ? '就绪' : '待填',
    id: i.id,
    label: i.label,
    value: i.value || '—'
  }))
  const w = (key) => Math.max(...rows.map((r) => [...r[key]].length), key.length)
  const [wState, wId, wLabel, wValue] = [w('state'), w('id'), w('label'), w('value')]
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length))
  const lines = [
    `${pad('状态', wState)}  ${pad('id', wId)}  ${pad('项目', wLabel)}  ${pad('当前值', wValue)}`,
    `${'-'.repeat(wState)}  ${'-'.repeat(wId)}  ${'-'.repeat(wLabel)}  ${'-'.repeat(wValue)}`
  ]
  for (const r of rows) {
    lines.push(
      `${pad(r.state, wState)}  ${pad(r.id, wId)}  ${pad(r.label, wLabel)}  ${pad(r.value, wValue)}`
    )
  }
  const todo = missingInputs(inputs)
  if (todo.length) {
    lines.push('', `待办 ${todo.length} 项（拿到值之后按 how 改，改完重跑本脚本）：`)
    for (const t of todo) {
      lines.push(`  • ${t.label}：${t.how}`, `      缺了会怎样：${t.missing}`)
    }
  } else {
    lines.push('', '外部输入已齐 —— 可以发版。')
  }
  return lines.join('\n')
}

function main() {
  const facts = collectFacts()
  const inputs = distributionInputs(facts)
  const todo = missingInputs(inputs)
  if (asJson) {
    console.log(
      JSON.stringify(
        { facts, inputs, missing: todo.map((t) => t.id), channelReady: updateChannelReady(facts) },
        null,
        2
      )
    )
  } else {
    console.log(renderReport(inputs))
    // 渠道没配时明确说清运行时行为，避免"配了但没生效"的误解
    console.log(
      facts.publishProvider
        ? `\n更新渠道判定：${updateChannelReady(facts) ? '真实渠道（打包后会写进 app-update.yml，用户可收到更新）' : '占位/未配 —— updater 会跳过检查（不会有失败通知）'}`
        : '\n更新渠道判定：electron-builder.yml 里没有 publish 段 —— updater 会跳过检查'
    )
  }
  if (release && todo.length) {
    console.error(
      `\n[dist:check] --release 模式下有 ${todo.length} 项外部输入未就绪，构建按约定失败。`
    )
    process.exit(1)
  }
}

// 只有直接运行时才执行（被测试 import 时不动）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
