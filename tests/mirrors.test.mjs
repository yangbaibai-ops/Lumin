// 仓库镜像入口（GitHub 主仓库 + Gitee / GitCode）：常量、菜单、关于页、白名单与文档。
//
// 为什么集中一条：这件事同时改到 shared 配置、两条菜单、关于页、三份语言包与两份 README，
// 而"少加一条镜像 / 只加了一处菜单 / 白名单漏了某个域名"都不会让别的测试变红。
// 这里从**唯一配置源**（`src/shared/appLinks.ts`）出发逐层对账，再把运行时白名单
// （`src/main/services/links.ts` 的 `safeProjectUrl`）当纯函数直接测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_HOMEPAGE,
  REPO_GITHUB,
  REPO_GITEE,
  REPO_GITCODE,
  REPO_MIRRORS,
  PROJECT_LINK_HOSTS,
  isProjectLinkHost
} from '../src/shared/appLinks.ts'
import { safeExternalUrl, safeProjectUrl, hostOf } from '../src/main/services/links.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))
const LANGS = ['zh-CN', 'en-US', 'ru-RU']

const GITHUB_URL = 'https://github.com/yangbaibai-ops/Lumin'
const GITEE_URL = 'https://gitee.com/yangbai-bai/Lumin'
const GITCODE_URL = 'https://gitcode.com/yangbaibai-ops/Lumin'

test('镜像常量：三个地址逐字正确，GitHub 仍是主仓库（APP_HOMEPAGE 同源）', () => {
  assert.equal(REPO_GITHUB, GITHUB_URL)
  assert.equal(REPO_GITEE, GITEE_URL)
  assert.equal(REPO_GITCODE, GITCODE_URL)
  assert.equal(APP_HOMEPAGE, REPO_GITHUB)
})

test('镜像清单：名称 + URL，顺序固定且全部 https', () => {
  assert.deepEqual(
    REPO_MIRRORS.map((m) => [m.id, m.name, m.url]),
    [
      ['github', 'GitHub', GITHUB_URL],
      ['gitee', 'Gitee', GITEE_URL],
      ['gitcode', 'GitCode', GITCODE_URL]
    ]
  )
  for (const m of REPO_MIRRORS) assert.match(m.url, /^https:\/\//, `${m.id} 必须 https`)
})

test('域名白名单：只有 GitHub / Gitee / GitCode（精确匹配，子域/后缀伪装一律拒）', () => {
  assert.deepEqual([...PROJECT_LINK_HOSTS], ['github.com', 'gitee.com', 'gitcode.com'])
  for (const ok of ['github.com', 'GITHUB.COM', 'gitee.com', 'gitcode.com', 'github.com.']) {
    assert.equal(isProjectLinkHost(ok), true, `${ok} 应被放行`)
  }
  for (const bad of [
    '',
    'evil.com',
    'github.com.evil.example',
    'evilgithub.com',
    'gitee.com.cn',
    'notgitcode.com'
  ]) {
    assert.equal(isProjectLinkHost(bad), false, `${bad} 不该被放行`)
  }
})

test('safeProjectUrl：三个仓库可开；非白名单域名 / 非 https / 危险协议一律拒', () => {
  for (const url of [GITHUB_URL, GITEE_URL, GITCODE_URL]) {
    assert.equal(safeProjectUrl(url), url)
  }
  for (const bad of [
    'https://example.com/Lumin',
    'https://github.com.evil.example/Lumin',
    'https://evilgithub.com/Lumin',
    'http://github.com/yangbaibai-ops/Lumin',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'mailto:a@b.c',
    ''
  ]) {
    assert.equal(safeProjectUrl(bad), null, `${bad} 不该通过项目白名单`)
  }
  // 文档链接那条路保持不变：任意 https 仍可交给浏览器，危险协议仍拒
  assert.equal(safeExternalUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeExternalUrl('javascript:alert(1)'), null)
})

test('native 菜单：帮助 → 项目主页 子菜单从 REPO_MIRRORS 派生且走 safeProjectUrl', () => {
  const menu = read('src/main/menu.ts')
  assert.match(menu, /import\s*\{\s*REPO_MIRRORS\s*\}\s*from\s*'\.\.\/shared\/appLinks'/)
  assert.match(menu, /import\s*\{\s*safeProjectUrl\s*\}\s*from\s*'\.\/services\/links'/)
  assert.match(menu, /const projectHomeItems[^\n]*REPO_MIRRORS\.map/)
  assert.match(menu, /label:\s*T\('projectHome'\)\s*,\s*submenu:\s*projectHomeItems/)
  assert.match(menu, /safeProjectUrl\(url\)/)
  assert.match(menu, /\[shell\] openExternal/)
  // 地址不许在菜单里抄第二份
  assert.doesNotMatch(menu, /gitee\.com|gitcode\.com/)
})

test('应用内顶部栏：帮助 → 项目主页 三条入口来自同一份清单、带 project scope', () => {
  const bar = read('src/renderer/src/components/TopMenuBar.vue')
  assert.match(
    bar,
    /import\s*\{\s*APP_DOCS_URL,\s*REPO_MIRRORS\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/shared\/appLinks'/
  )
  assert.match(bar, /labelKey:\s*'menu\.projectHome'/)
  assert.match(bar, /children:\s*REPO_MIRRORS\.map/)
  assert.match(bar, /openExternal\(url,\s*'project'\)/)
  assert.doesNotMatch(bar, /gitee\.com|gitcode\.com/)
})

test('关于页：版本信息下方有可点击的三条仓库链接（清单来自 appLinks）', () => {
  const about = read('src/renderer/src/views/AboutView.vue')
  assert.match(about, /data-about-mirrors/)
  assert.match(about, /v-for="mirror in REPO_MIRRORS"/)
  assert.match(about, /:data-about-mirror="mirror\.id"/)
  assert.match(about, /openExternal\(url,\s*'project'\)/)
  // 链接块必须紧跟在版本/平台卡片之后（用户口径：版本信息下方）
  const versionAt = about.indexOf("{{ t('about.version') }}")
  const mirrorsAt = about.indexOf('data-about-mirrors')
  const depsAt = about.indexOf('data-about-deps')
  assert.ok(
    versionAt > 0 && mirrorsAt > versionAt && depsAt > mirrorsAt,
    '镜像块应在版本信息下方、技术栈上方'
  )
})

test('i18n 三语：menu.projectHome / about.mirrors / about.mirrorsHint 齐全非空', () => {
  for (const lang of LANGS) {
    const pack = readJson(`src/shared/i18n/${lang}.json`)
    for (const [section, key] of [
      ['menu', 'projectHome'],
      ['about', 'mirrors'],
      ['about', 'mirrorsHint']
    ]) {
      const value = pack[section]?.[key]
      assert.equal(
        typeof value === 'string' && value.trim().length > 0,
        true,
        `${lang} 缺 ${section}.${key}`
      )
      if (lang !== 'zh-CN')
        assert.doesNotMatch(value, /[\u4e00-\u9fff]/, `${lang}.${section}.${key} 有中文残留`)
    }
  }
})

test('README 中英两版：镜像小节 + 三条 URL + 主仓库/Issue 口径', () => {
  for (const [file, heading, primary, issues] of [
    ['README.md', '## Mirrors', /primary repository/i, /issues on GitHub/i],
    ['README.zh-CN.md', '## 镜像', /主仓库/, /Issue 请优先提交到 GitHub/]
  ]) {
    const text = read(file)
    assert.ok(text.includes(heading), `${file} 缺少镜像小节标题 ${heading}`)
    for (const url of [GITHUB_URL, GITEE_URL, GITCODE_URL]) {
      assert.ok(text.includes(url), `${file} 缺少镜像地址 ${url}`)
    }
    assert.match(text, primary, `${file} 未注明 GitHub 是主仓库`)
    assert.match(text, issues, `${file} 未注明 Issue 优先提到 GitHub`)
  }
})

test('docs/README.md：仓库链接处补充 Gitee / GitCode 镜像', () => {
  const docs = read('docs/README.md')
  for (const url of [GITHUB_URL, GITEE_URL, GITCODE_URL]) {
    assert.ok(docs.includes(url), `docs/README.md 缺少仓库地址 ${url}`)
  }
})

test('package.json：homepage/repository 仍指向 GitHub，bugs 不指镜像', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.homepage, REPO_GITHUB)
  assert.equal(pkg.repository, REPO_GITHUB)
  assert.match(pkg.bugs.url, /^https:\/\/github\.com\//)
})

test('IPC：project scope 走 safeProjectUrl，成功日志用 [shell] 前缀', () => {
  const ipc = read('src/main/ipc.ts')
  assert.match(
    ipc,
    /isProject\s*\?\s*links\.safeProjectUrl\(url\)\s*:\s*links\.safeExternalUrl\(url\)/
  )
  assert.match(ipc, /const tag = isProject \? '\[shell\]' : '\[links\]'/)
  assert.match(ipc, /links\.hostOf\(url\)/)
})

test('hostOf：只取主机名（日志里不泄漏完整 URL）', () => {
  assert.equal(hostOf('https://Gitee.com/yangbai-bai/Lumin?x=1#y'), 'gitee.com')
  assert.equal(hostOf('not a url'), 'invalid')
  assert.equal(hostOf(''), 'invalid')
})
