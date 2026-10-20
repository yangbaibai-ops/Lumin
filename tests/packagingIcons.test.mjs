// ─── 图标全链路：四层都必须指向同一份 resources/icon.ico ────────────────────────
//
// 用户报障（原始口径）：「桌面图标依旧是 Electron 的图标」。上一轮只改了 `win.icon`
// （exe 资源段），于是 exe 图标对了，但安装包/快捷方式那条链仍有各自的配置。这里把
// **每一层**的配置都钉住，防止下次升级 electron-builder 或改配置时又悄悄退回默认值：
//
//   ① `win.icon`                     → 嵌进 Lumin.exe 资源段（任务栏/Alt+Tab/资源管理器）
//   ② `nsis.installerIcon`           → 安装包**自身**的图标（用户双击的那个 setup.exe）
//   ③ `nsis.uninstallerIcon`         → 卸载程序（「应用和功能」里看到的那一个）
//   ④ `nsis.installerHeaderIcon`     → 安装向导页眉（NSIS 的 HEADER_ICO）
//
// 关于默认值（读的是 app-builder-lib/out/targets/nsis/NsisTarget.js，已核对）：
//   * installerIcon 不配时**回退到 win.icon**（所以本机实测安装包图标曾经就是对的）；
//   * uninstallerIcon / installerHeaderIcon 不配时没有这个回退 —— 页眉会落回 NSIS 默认，
//     这正是「装了新包，向导顶上的图还是 Electron」的来源。显式写死三处，不留隐式回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('electron-builder.yml：四层图标全部显式指向 resources/icon.ico', () => {
  const yml = read('electron-builder.yml')
  // win.icon（两空格缩进，且在 win: 段里；mac/linux 用的是 icon.png，不能误配）
  assert.match(yml, /^win:\n(?:.|\n)*?^ {2}icon: resources\/icon\.ico$/m, 'win.icon 丢了')
  for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) {
    assert.match(
      yml,
      new RegExp(`^ {2}${key}: resources/icon\\.ico$`, 'm'),
      `nsis.${key} 必须显式指向 resources/icon.ico（不配就没有回退/回退到 Electron 默认）`
    )
  }
  // 自定义 NSIS 段仍然挂着（卸载清关联 + InstallLocation 靠它）
  assert.match(yml, /include: build\/installer\.nsh/)
})

test('icon.ico 必须是多档 32 位 DIB（否则 GDI+ 取图标会失败 → 显示缺省图标）', () => {
  const file = join(ROOT, 'resources', 'icon.ico')
  assert.ok(existsSync(file), 'resources/icon.ico 不存在')
  const buf = readFileSync(file)
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  assert.equal(reserved, 0)
  assert.equal(type, 1, '不是 ICO 文件')
  assert.ok(count >= 7, `图标档位不足：${count}（需要 16/24/32/48/64/128/256）`)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    sizes.push({ w: buf[off] || 256, h: buf[off + 1] || 256, bits: buf.readUInt16LE(off + 6) })
  }
  assert.ok(
    sizes.some((s) => s.w === 32 && s.h === 32),
    '缺 32×32 档（资源管理器最常用）'
  )
  assert.ok(
    sizes.some((s) => s.w === 256 && s.h === 256),
    '缺 256×256 档（大图标视图）'
  )
  for (const s of sizes) assert.equal(s.bits, 32, `${s.w}×${s.h} 不是 32 位`)
})

test('package.json 不许再长出 build 字段（否则 electron-builder.yml 整份失效）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal('build' in pkg, false, 'package.json 的 build 字段会覆盖 electron-builder.yml')
})

test('build/ 里不许有会覆盖显式配置的 installerIcon.ico / uninstallerIcon.ico', () => {
  // getResource(name, defaultName) 会先在 buildResources 里找 defaultName；
  // 显式配置之后这两个默认名不该再出现（出现说明有人又塞了一份"另一套图标"）
  const dir = join(ROOT, 'build')
  for (const name of ['installerIcon.ico', 'uninstallerIcon.ico', 'installerHeaderIcon.ico']) {
    assert.equal(existsSync(join(dir, name)), false, `build/${name} 会与显式配置抢所有权`)
  }
  assert.ok(statSync(join(ROOT, 'resources', 'icon.ico')).size > 0)
})
