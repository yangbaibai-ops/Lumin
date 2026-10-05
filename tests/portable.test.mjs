// ─── 便携版的数据目录判定（报告 §P2「功能缺口：便携版」）────────────────────────
//
// 便携版有两种含义，最容易混：
//   * **免安装** —— electron-builder 的 `portable` target 给的；
//   * **数据随身** —— 需要应用自己把 userData 改到 exe 旁边（见 src/shared/portable.ts）。
// 这里钉住第二条的判定，以及在**真实代码**里它有没有被接上、有没有被"模块级路径捕获"绕过去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PORTABLE_DATA_DIR_NAME,
  PORTABLE_DIR_ENV,
  portableDataDir
} from '../src/shared/portable.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

test('不在便携模式（没有环境变量）→ null（绝不擅自动用户的 userData）', () => {
  assert.equal(portableDataDir({}), null)
  assert.equal(portableDataDir({ PORTABLE_EXECUTABLE_DIR: undefined }), null)
  assert.equal(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '' }), null)
  assert.equal(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '   ' }), null)
  // 别的平台的变量名不该被误认
  assert.equal(portableDataDir({ APPDIR: '/tmp/appimage' }), null)
})

test('便携模式 → exe 同级下的 LuminData（Windows 反斜杠 / POSIX 斜杠都正确拼接）', () => {
  assert.equal(
    portableDataDir({ [PORTABLE_DIR_ENV]: 'D:\\Lumin' }),
    `D:\\Lumin\\${PORTABLE_DATA_DIR_NAME}`
  )
  assert.equal(
    portableDataDir({ [PORTABLE_DIR_ENV]: '/media/usb/Lumin' }),
    `/media/usb/Lumin/${PORTABLE_DATA_DIR_NAME}`
  )
  // 末尾分隔符：'D:\Lumin\' 与 'D:\Lumin' 是同一个目录，拼出来不该出现双斜杠
  assert.equal(
    portableDataDir({ [PORTABLE_DIR_ENV]: 'D:\\Lumin\\' }),
    `D:\\Lumin\\${PORTABLE_DATA_DIR_NAME}`
  )
  assert.equal(
    portableDataDir({ [PORTABLE_DIR_ENV]: '/media/usb/Lumin//' }),
    `/media/usb/Lumin/${PORTABLE_DATA_DIR_NAME}`
  )
  // 前后空格（环境变量被引号包过之类）要剪掉
  assert.equal(
    portableDataDir({ [PORTABLE_DIR_ENV]: '  D:\\Lumin  ' }),
    `D:\\Lumin\\${PORTABLE_DATA_DIR_NAME}`
  )
})

test('落在 asar 里的路径一律拒绝：那是只读的，改 userData 过去必然写不进去', () => {
  assert.equal(portableDataDir({ [PORTABLE_DIR_ENV]: 'C:\\app\\resources\\app.asar' }), null)
  assert.equal(portableDataDir({ [PORTABLE_DIR_ENV]: '/opt/lumin/app.asar/unpacked' }), null)
  // 只是名字里带 asar 的正常目录不该被误伤
  assert.equal(
    portableDataDir({ [PORTABLE_DIR_ENV]: 'D:\\asar-backup' }),
    `D:\\asar-backup\\${PORTABLE_DATA_DIR_NAME}`
  )
})

test('主进程真的接上了：便携时 setPath(userData)，失败则退回默认并留日志', () => {
  const main = read('src/main/index.ts')
  assert.match(main, /from '\.\.\/shared\/portable'/, 'index.ts 必须用共享判定')
  assert.match(main, /portableDataDir\(process\.env\)/, '要传真实环境变量')
  assert.match(main, /app\.setPath\('userData', dir\)/, '必须真的改 userData')
  assert.match(
    main,
    /mkdirSync\(dir, \{ recursive: true \}\)/,
    '目录要先建出来（U 盘上首次运行为空）'
  )
  // 失败路径必须存在：写不了 U 盘时退回默认，别让应用起不来
  assert.match(main, /fallback to default userData/, '失败要留一行 ASCII 日志并退回默认')
  // 而且必须在**模块级 userData 读取之前**执行：判定调用出现在文件前 1/4
  const at = main.indexOf('applyPortableDataDir()')
  assert.ok(at > 0 && at < main.length / 4, `applyPortableDataDir() 必须尽早调用（位置 ${at}）`)
})

test('没有模块级 userData 捕获（否则便携改路径对它无效）', () => {
  // 波次 2 之前的写法：const draftsDir = path.join(app.getPath('userData'), 'drafts')
  // 它会让草稿永远留在 %APPDATA%，而其它数据跟着 exe 走 —— 一半随身比不随身更难查
  const drafts = read('src/main/drafts.ts')
  assert.doesNotMatch(
    drafts,
    /^(?:const|let)\s+\w*[Dd]ir\w*\s*=\s*path\.join\(\s*app\.getPath\('userData'\)/m,
    'drafts.ts 不许在模块级捕获 userData 路径（要惰性求值）'
  )
  assert.match(drafts, /function draftsDir\(\): string/, '草稿目录要按需取')
  // 全仓扫一遍：主进程里任何模块级 const/let 直接捕获 userData 都算回归
  const offenders = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!name.endsWith('.ts')) continue
      const src = fs.readFileSync(p, 'utf-8')
      const re = /^(?:const|let)\s+\w+\s*=\s*[^\n]*app\.getPath\('userData'\)/gm
      if (re.test(src)) offenders.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  walk(path.join(ROOT, 'src/main'))
  assert.deepEqual(offenders, [], `这些文件在模块级捕获了 userData：${offenders.join(', ')}`)
})

test('打包配置：便携 target 存在且不进默认 win.target（发版时不多产一个几十 MB 的包）', () => {
  const yml = read('electron-builder.yml')
  assert.match(yml, /^portable:/m, '要有 portable 段')
  assert.match(
    yml,
    /artifactName:\s*Lumin-\$\{version\}-portable\.\$\{ext\}/,
    '便携包命名要能一眼认出'
  )
  assert.match(yml, /unpackDirName:\s*Lumin/, '解包目录名固定，便于复用')
  assert.match(yml, /requestExecutionLevel:\s*user/, '免安装不请求提权')
  // win.target 里只该有 nsis（便携由独立脚本产出）
  const winBlock = yml.slice(yml.indexOf('\nwin:'), yml.indexOf('\nportable:'))
  assert.doesNotMatch(winBlock, /-\s*target:\s*portable/, 'portable 不该进默认 win.target')
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts['build:portable'], /electron-builder --win portable/)
})
