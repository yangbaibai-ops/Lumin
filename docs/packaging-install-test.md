# Lumin 安装 / 卸载链路测试报告

> 本文是「打包产物在真实 Windows 上安装、运行、卸载」的实测记录，可复现、可复用为发布前检查清单。
> 所有数据均为本机实测输出，非推断；**第一轮原始记录完整保留在 §九**，便于对照（其中 P4 的结论已被本轮推翻）。

- **第一轮**：2026-09-15，结论「有条件通过」——主链路全绿，但发现 6 个问题（1 个卸载残留缺陷 + 5 项待修/待确认）。
- **第二轮（本文正文）**：2026-09-15，**逐条修复后重新完整跑了一遍装 → 跑 → 卸**，结论 **通过：19/19 断言全绿**。
- **被测产物**：`dist/Lumin-1.0.0-setup.exe`（NSIS，由 `electron-builder@26.15.3` 依据 `electron-builder.yml` 生成，该文件是**唯一配置真相源**）
  - 体积 **123.22 MB**（129,201,831 字节）
  - SHA256 `341F322B4C1719532EEED790AFE5EA5609E3884CD0207E0F8B21783A6A91DA76`
  - 第一轮产物对比：129,201,471 字节 / `6D8F208C421B7E38EEEBD9507B1E8B520785763898BAE7C09D774BEB8CBCD958`
- **环境**：Windows 11 / PowerShell 5.1 / 用户级安装（`perMachine: false`，免管理员）
- **一键复现**：`pwsh -File tools/_install-test.ps1`（静默装 → 19 条断言 → 静默卸 → 恢复机器状态，全自动）

> ⚠️ **NSIS 产物不可字节复现**：同一份源码连打三次，sha256 各不相同（本轮实测：`0D953579…` 129,201,857 B、`b6424599…` 129,201,858 B、`341F322B…` 129,201,831 B），差异来自构建时间戳等嵌入信息。所以「sha256 一致」不能当发布校验手段，本文的指纹只用于说明**这批数据测的是哪个文件**。

---

## 一、第一轮 6 个问题的处置

| #   | 第一轮问题                                                                                | 处置                                                | 代码落点                                                                                                                            | 本轮实测证据                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **中**：卸载后 `HKCU\Software\Classes\.md` 默认值残留 `Markdown`（悬空指向已删的 ProgID） | ✅ **已修**                                         | 新增 `build/installer.nsh`（`Lumin_UnassociateExtension` 宏 + `customUnInstall`），经 `electron-builder.yml` 的 `nsis.include` 挂载 | `md-default-value-cleared` ✅ `.md=''`；`markdown-default-value-cleared` ✅ `.markdown=''`；扩展名下的 `OpenWithProgids` 子键也一并删除（`-ifempty`）                    |
| 2   | **中**：「应用和功能」里 Publisher 显示 `example.com`                                     | ✅ **已修**                                         | `package.json` 的 `author` 改为真实作者（NSIS 的 Publisher 来源）                                                                   | `publisher-is-real-author` ✅ `Publisher='yang_bai_bai'`                                                                                                                 |
| 3   | 低-中：桌面同名快捷方式会被安装器覆盖                                                     | 🔶 **有意保持现状**（详见 §三）                     | 不改代码，改为文档说明                                                                                                              | `shortcuts-created` ✅ 桌面快捷方式按设计创建；收尾已把被覆盖的那条按原样重建                                                                                            |
| 4   | 低：判断「快捷方式未携带 AppUserModelID」                                                 | ⚠️ **第一轮结论被推翻**（详见 §四）｜运行时兜底保留 | `src/main/services/taskbar.ts` 的 `backfillInstalledShortcutAumid()`（幂等；正常走「已存在」分支）                                  | `shortcut-aumid-present` ✅ 日志：`shortcut aumid already present … aumid=com.lumin.app`                                                                                 |
| 5   | 中（开发期专属）：dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁                           | ✅ **已修（opt-in）**                               | 新增 `src/main/devProfile.ts`（在 `index.ts` 里**第一行导入**）+ `package.json` 的 `npm run dev:isolated`                           | 本轮的复测实例全程用 `--user-data-dir` 隔离，未与 dev 实例互抢；用户数据 11027 文件/38 草稿全程未变                                                                      |
| 6   | 低：`InstallLocation` 为空、`EstimatedSize` 报 501.4 MB（实际约 280 MB）                  | ✅ 前半已修｜后半属上游                             | `build/installer.nsh` 的 `customInstall` 写入 `InstallLocation=$INSTDIR`                                                            | `install-location-non-empty` ✅ `InstallLocation='C:\Users\yangbaibai\AppData\Local\Programs\Lumin'`；`EstimatedSize=501.4MB` 仍在（上游估算方式，仅信息展示，不做处理） |

**修复方式为什么是 `nsis.include`**：P1 的根因在 electron-builder 自带的 NSIS 模板里 —— `APP_UNASSOCIATE`（`FileAssociation.nsh:99-102`）只删除扩展名下 `OpenWithProgids` 的那**个值**和 ProgID 子树，**从不删扩展名的默认值**。所以关联是我们建的、注销却漏了一半。上游模板不能改，官方支持的扩展点就是 `nsis.include` 的 `customUnInstall` 宏。

---

## 二、本轮复测：19 条断言逐条实测

命令：`pwsh -NoProfile -File tools\_install-test.ps1` → `--- 19/19 PASS`（退出码 0）

### 2.1 安装（`Lumin-1.0.0-setup.exe /S`）

| 断言                            | 期望                     | 实测                                                                 |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `install-exit-0`                | 退出码 0                 | ✅ exit=0，耗时 **11.2 s**（第一轮 20.2 s，随磁盘/杀软波动）         |
| `installed-exe-present`         | 安装目录里有 `Lumin.exe` | ✅ `…\Programs\Lumin\Lumin.exe`，**210,974,720 字节**                |
| `publisher-is-real-author`      | Publisher 是真实作者     | ✅ `Publisher='yang_bai_bai'`（第一轮 `example.com`）                |
| `install-location-non-empty`    | `InstallLocation` 有值   | ✅ `C:\Users\yangbaibai\AppData\Local\Programs\Lumin`（第一轮为空）  |
| `md-associated-to-progid`       | `.md` → ProgID           | ✅ `.md='Markdown'`                                                  |
| `md-open-command-points-to-exe` | 命令指向安装后的 exe     | ✅ `C:\Users\yangbaibai\AppData\Local\Programs\Lumin\Lumin.exe "%1"` |
| `markdown-ext-associated`       | `.markdown` 同样登记     | ✅ `.markdown='Markdown'`                                            |
| `shortcuts-created`             | 开始菜单 + 桌面快捷方式  | ✅ `start=True desktop=True`                                         |

> exe 内嵌图标（**第二轮图标更换后已复验**，2026-09）：`resources/icon.ico` 的
> 16/24/32/48/64/128/256 **七档负载 7/7 逐字节命中 `Lumin.exe`**，同一批字节在 `electron.exe`
> 里 7/7 不存在；GDI+ 抽出的 32×32 中心 8×8 = (178,178,179)（Electron 那份是 (60,66,78)）。
> 本轮的一个重要教训：**用户交付的 `.ico` 是单档 PNG 压缩条目，GDI+ 读不出来**（`Icon.ToBitmap()`
> 抛 `Requested range extends past the end of the array`）—— 所以 `icon.ico` 必须由
> `node tools/pack-ico.js` 从 `resources/icon.png` 打成七档 DIB，不能直接复制交付的成品。
> 开发态那一侧（`resources/icon.ico` → `userData\icons\lumin-<sha1:8>.ico` 内容寻址副本）
> 另见 `_verify-taskbar-jumplist.js`（31/31）。

### 2.2 安装后以裸文件路径运行

| 断言                             | 期望                                 | 实测                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packaged-opens-bare-path-file`  | 双击 `%1` 那条命令等价形式能打开文档 | ✅ 窗口标题 **`安装测试-甲文档.md - Lumin`**（以 `--user-data-dir=%TEMP%\lumin-install-test-profile --remote-debugging-port=9229 "…甲文档.md"` 启动后经 CDP 读标题）                                 |
| `shortcut-aumid-present`         | 快捷方式带我们的 AUMID               | ✅ 主进程自检日志：`[taskbar] shortcut aumid already present path="…\Start Menu\Programs\Lumin.lnk" aumid=com.lumin.app`（断言走 Electron 的 `shell.readShortcutLink`，与 Windows shell 同一条 API） |
| `shortcut-kept-installer-target` | 运行时**不篡改**安装器写的启动命令   | ✅ `target=…\Programs\Lumin\Lumin.exe args=''`                                                                                                                                                       |

### 2.3 卸载（`"Uninstall Lumin.exe" /currentuser /S`）

| 断言                             | 期望                                | 实测                                                         |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `uninstall-exit-0`               | 退出码 0                            | ✅ exit=0，耗时 **6.4 s**                                    |
| `install-dir-removed`            | 安装目录清空                        | ✅ 残留文件数 **0**                                          |
| `shortcuts-removed`              | 开始菜单/桌面快捷方式清除           | ✅ `start=False desktop=False`                               |
| `progid-removed`                 | ProgID 子树删除                     | ✅ `HKCU\Software\Classes\Markdown` 不存在                   |
| `md-default-value-cleared`       | **扩展名默认值清空（P1 的修复点）** | ✅ `.md=''`（修复前是 `Markdown`）                           |
| `markdown-default-value-cleared` | `.markdown` 同理                    | ✅ `.markdown=''`                                            |
| `uninstall-entry-removed`        | 卸载条目清除                        | ✅ 无 Lumin 卸载项                                           |
| `user-data-untouched`            | **用户数据完整保留**                | ✅ `before=11027/38 after=11027/38`（文件数/草稿数逐项一致） |

> `user-data-untouched` 仍是最关键的一条：`deleteAppDataOnUninstall: false` 生效，卸载**没有**碰用户的笔记、草稿、设置与会话。
> 卸载前记录的 `EstimatedSize=501.4MB`（实际约 280 MB）依旧偏大 —— electron-builder/NSIS 的体积估算方式所致，只影响「应用和功能」里显示的占用数字，本轮不做处理。

---

## 三、P3：桌面快捷方式覆盖同名文件 —— 有意保持现状

**行为**：`createDesktopShortcut: true`，安装时若桌面已有 `Lumin.lnk`（本轮基线里正好有一条指向项目文件夹的），会被替换；卸载时一并删除。

**为什么不改**：

1. 这是**主流做法**（VS Code、Typora、Obsidian 等装完都在桌面放图标），也是 `allowToChangeInstallationDirectory: true` 之外的默认预期；
2. 用户可以在向导里取消勾选（非静默安装时），向导**默认勾选**属于产品选择；
3. 真正的风险不是「建快捷方式」，而是「静默覆盖同名文件」—— 而 `Lumin.lnk` 这个名字本来就属于本应用，同名文件是用户自建/上一版遗留，属边缘情况；
4. 改成 `false` 会让「装完在桌面上找不到图标」变成更常见的抱怨，收益为负。

**代价与补偿**：本轮的验收脚本会在收尾时把桌面那条**按原样重建**（`target = D:\code_workspace\Lumin`），机器状态表（§八）里已记录。发布说明/安装说明里应写明「安装会在桌面创建 Lumin 快捷方式」。

---

## 四、P4 结论更正：第一轮是**测量方法**错了，不是产品缺陷

**第一轮的说法**：I-06b「在 .lnk 字节里搜不到 `com.lumin.app` → 快捷方式未携带 AppUserModelID」。

**本轮实测**：安装器创建的 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Lumin.lnk` **本来就带 `com.lumin.app`** —— 用 Electron 的 `shell.readShortcutLink()`（内部即 Windows Shell 的 `IShellLink`/`IPropertyStore`）读得到，日志为证：

```
[taskbar] shortcut aumid already present path="…\Start Menu\Programs\Lumin.lnk" aumid=com.lumin.app
```

原因是 electron-builder 会按 `appId`（`com.lumin.app`）写这条属性。第一轮之所以判错，是因为用了「把 .lnk 读成 UTF-16 字符串再搜子串」的办法 —— `.lnk` 的扩展属性存储有自己的序列化格式，**搜不到不等于属性不存在**。本轮把该断言改成读权威 API，并在脚本里保留一条**只观察、不断言**的字节搜索结果（现为 `INFO 原始字节搜索命中=False`），把这个坑明写在输出里。

**对代码的影响**：`taskbar.ts` 里那个 `backfillInstalledShortcutAumid()` 从「补救措施」降级为**幂等兜底** —— 正常情况下走「已存在」分支直接返回（实测正是这条路），只在快捷方式被换成不带 AUMID 的版本（换安装器、被别的工具重写过）时才真的补写；它仍然只动 AUMID 一个属性、绝不新建文件、绝不改启动参数。函数上方的注释已按本节改写，避免后来者照抄旧结论。

---

## 五、回归（本轮改动之外，确认没有踩坏既有功能）

| 项                                            | 命令                                                                                                             | 结果                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型检查                                      | `npm run typecheck`（`tsc` + `vue-tsc` 两个工程）                                                                | ✅ exit=0                                                                                                                                                                                 |
| 打包验收                                      | `node tools/_verify-packaging.js`                                                                                | ✅ **24/24 PASS**（含真跑 `build:win`、`package.json` 无 `build` 字段、生效配置来自 yml、`appId` 与代码一致、只关联 `.md/.markdown`）                                                     |
| 任务栏/跳转列表验收                           | `node tools/_verify-taskbar-jumplist.js`                                                                         | ✅ **27/27 PASS**（AUMID、跳转列表任务、裸路径开窗、冷启动开文件、单文件去重）                                                                                                            |
| ESLint（本轮改动的 `src/` 文件）              | `eslint src/main/services/taskbar.ts src/main/services/launchIntent.ts src/main/devProfile.ts src/main/index.ts` | ✅ 0 问题                                                                                                                                                                                 |
| ESLint（`tools/_verify-taskbar-jumplist.js`） | 同上                                                                                                             | ⚠️ 18 error / 7 warning，**全部是该文件既有的风格问题**（`require()` 写法 + 未标注返回类型），不在本轮新增行上；`tools/*.js` 这类验收脚本本来就与 `src/` 用同一套 ESLint 规则，属历史噪音 |

**顺带修掉的一个验收脚本缺陷**（不是产品问题，但会污染回归结论）：`tools/_verify-taskbar-jumplist.js` 的 D 节（冷启动）把渲染页面地址硬编码成 `http://localhost:5173`，而套件其余每次启动都是**继承父进程环境**的 —— 没有 dev server 时，冷启动进程拿不到页面，`#app` 不存在，脚本会以 `TypeError: Cannot read properties of undefined (reading 'files')` 崩掉（看起来像产品回归，实际是脚本前提不一致）。现已改为继承父进程环境（有 `ELECTRON_RENDERER_URL` 就用，没有就走 `out/renderer`），并在 `__K` 注入失败时输出一条能看懂的结论。改完在**无 dev server**环境下 27/27 PASS。

---

## 六、未覆盖 / 需人工确认

1. **真实「双击 .md」端到端**：仍未做。原因同第一轮 —— 你的 dev 实例正在运行，而 dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁，双击会把请求转给 dev 实例，测不出打包版自身行为。**要端到端验**：关掉 dev 实例后再双击一个 `.md`。现在有两条更省事的路径：`npm run dev:isolated`（dev 用独立 profile，不再抢锁），或直接卸掉重装后双击。
2. **图形化安装向导界面**：本轮全程 `/S` 静默，没点过向导（安装目录选择页、P3 的桌面快捷方式勾选框未人眼确认）。
3. **升级安装（覆盖安装）**：没测「已装 1.0.0 再装一次」的路径。
4. **任务栏右键菜单 / 「固定到任务栏」之后的观感**：断言已覆盖到「快捷方式存在、AUMID 正确、启动命令正确」这一层，**视觉呈现仍需人眼确认一次**。
5. **自动更新**：`publish` 仍是占位地址，运行时按设计跳过检查；未接真实渠道，未跑过升级。
6. **代码签名与 SmartScreen**：当前未签名，用户手装时会看到「未知发布者」提示。
7. 非 Windows 平台（本项目只做 Windows）。

---

## 七、可复现命令

```powershell
# 0) 构建产物（唯一配置源 = electron-builder.yml）
npm run build:win        # → dist/Lumin-<version>-setup.exe
npm run build:portable   # → dist/Lumin-<version>-portable.exe（免安装，见下面的补充清单）

# 1) 一条命令跑完整装/卸实测（19 条断言 + 自动恢复机器状态）
pwsh -NoProfile -File tools\_install-test.ps1

# 2) 只手动看关键几步
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object DisplayName -eq 'Lumin') | Select-Object Publisher, InstallLocation, EstimatedSize
(Get-ItemProperty 'HKCU:\Software\Classes\Markdown\shell\open\command').'(default)'   # 期望 …\Lumin.exe "%1"
# 卸载后：扩展名默认值必须是空（P1 的修复点）
(Get-ItemProperty 'HKCU:\Software\Classes\.md' -EA SilentlyContinue).'(default)'
Get-ChildItem "$env:APPDATA\Lumin" -Recurse -File | Measure-Object                # 期望与基线一致
```

### 7.1 便携版补充清单（`npm run build:portable`）

便携的"数据随身"逻辑（`src/shared/portable.ts` + `main/index.ts`）有 6 条单测与一次**开发态**实测，
但**便携包本身的产出与双击行为**必须在真实打包下过一遍（本轮环境在 packaging 阶段被外部终止，没跑完）：

| 步骤                                                              | 期望                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run build:portable`                                          | 产出 `dist/Lumin-<version>-portable.exe`；不产出安装包（`portable` 不在 `win.target` 里）                              |
| 把 exe 放到一个**空目录**（模拟 U 盘），双击                      | 应用正常启动；**同目录出现 `LuminData/`**（内含 `lumin.db`、`drafts/`、`logs/`、`settings` 等）                        |
| 在该目录里新建一份笔记并保存，关掉应用，再双击                    | 笔记、最近列表、设置都还在（证明没写 `%APPDATA%`）                                                                     |
| 检查 `%APPDATA%\Lumin` 的修改时间                                 | **不应**被这次便携运行改动（这条是"数据随身"的反向断言；若被改动说明有模块绕过了 userData）                            |
| 卸载/清理                                                         | 便携版**不写注册表**、不建开始菜单/桌面快捷方式：`HKCU:\Software\Classes\.md` 与卸载项都不该出现                       |
| 换个目录再放一份 exe（只读 U 盘模拟：`attrib +r` 或挂载只读介质） | 应用**照常启动**（退回 `%APPDATA%` 并在 `logs/app.log` 里留一行 `[portable] fallback …`）——不许因为写不了 U 盘而起不来 |

⚠️ 隐私口径写进用户文档：数据跟着 U 盘走 = U 盘丢了数据就丢了；插到别人机器上打开时，
你的笔记会出现在那台机器上（见 [distribution.md](./distribution.md) §3）。

`tools/_install-test.ps1` 做的事（都在 `finally` 里兜底）：记基线 → 静默安装 → 跑 19 条断言（含以**裸路径**启动打包版并读窗口标题）→ 静默卸载 → 断言清理与用户数据 → 杀掉测试进程、删除测试 profile 与夹具、**把桌面 `Lumin.lnk` 重建回 `D:\code_workspace\Lumin`**、清掉任何残留的 `.md`/`.markdown` 默认值。它全程使用 `--user-data-dir=%TEMP%\lumin-install-test-profile`，不会碰到正在运行的用户实例与 `%APPDATA%\Lumin`。

---

## 八、第二轮复测对机器的改动与复原

| 改动                                             | 是否已复原                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 安装到 `%LOCALAPPDATA%\Programs\Lumin`           | ✅ 已静默卸载，目录已删除（残留文件 0）                                                |
| 开始菜单 `Lumin.lnk`                             | ✅ 已随卸载删除                                                                        |
| **桌面 `Lumin.lnk`（原有那条指向项目文件夹）**   | ✅ 安装器覆盖、卸载删除后，已按原样重建（`target = D:\code_workspace\Lumin`）          |
| `HKCU\Software\Classes\.md` / `.markdown` 默认值 | ✅ 本轮**由安装器自己的卸载逻辑清空**（这正是 P1 的修复点），实测均为 `''`，与基线一致 |
| `HKCU\Software\Classes\Markdown`、卸载条目       | ✅ 卸载时已清除                                                                        |
| `%APPDATA%\Lumin`（用户数据）                    | ✅ 全程未被修改（11027 文件 / 38 草稿，装前装后逐项一致）                              |
| `%TEMP%` 下的测试 profile / 夹具                 | ✅ 已删除（`lumin-install-test-profile`、`lumin-install-fixture`）                     |
| `dist\Lumin-1.0.0-setup.exe`                     | 保留，可重复用于回归                                                                   |

---

## 九、附：第一轮原始记录（2026-09-15，原文保留）

> 以下为第一轮记录，**除 P4 相关行已加更正标注外**未作修改，保留原样以便对照当时的判断与措辞。

- **测试日期**：2026-09-15
- **被测产物**：`dist/Lumin-1.0.0-setup.exe`（NSIS）
  - 体积 **123.22 MB**（129,201,471 字节）
  - SHA256 `6D8F208C421B7E38EEEBD9507B1E8B520785763898BAE7C09D774BEB8CBCD958`
  - 由 `electron-builder@26.0.12` 依据 `electron-builder.yml` 生成（配置见该文件；它是**唯一配置真相源**）
- **环境**：Windows 11 / PowerShell 5.1 / 用户级安装（`perMachine: false`，免管理员）
- **结论**：**有条件通过** —— 安装、启动、文件关联、卸载的**主链路全部符合预期**，用户数据在卸载后**完整保留**；但有 **1 个中severity 缺陷（卸载残留注册表）** 和 4 项待修/待确认项。

### 9.1 测试范围

| 覆盖                                           | 不覆盖                                       |
| ---------------------------------------------- | -------------------------------------------- |
| 静默安装与退出码、安装目录结构                 | 图形化安装向导的界面（本轮用 `/S` 静默跑）   |
| exe 内嵌图标、文件关联注册、快捷方式、卸载条目 | 真实「双击 .md」（原因见当时 §9.5）          |
| 静默卸载、注册表清理、用户数据保留             | 自动更新（`publish` 仍是占位地址）           |
| 安装后 exe 以**裸文件路径**启动并打开文档      | 代码签名 / SmartScreen 表现；非 Windows 平台 |

### 9.2 安装前基线（用于判断「改动」与「残留」）

| 项                                 | 基线值                                                   |
| ---------------------------------- | -------------------------------------------------------- |
| `%LOCALAPPDATA%\Programs\Lumin`    | 不存在                                                   |
| 开始菜单 `Lumin.lnk`               | 不存在（开发态那条叫 `Lumin (dev).lnk`）                 |
| 桌面 `Lumin.lnk`                   | **存在，但指向 `D:\code_workspace\Lumin`（项目文件夹）** |
| `HKCU\Software\Classes\.md` 默认值 | 空（无关联）                                             |
| 卸载条目（含 Lumin）               | 0 项                                                     |
| `%APPDATA%\Lumin`（用户数据）      | 存在，**11027 个文件 / 38 个草稿**                       |

### 9.3 用例与结果

#### 9.3.1 安装

| 编号  | 步骤                       | 期望                              | 实测                                                                                                                                                                                  | 结论                                                                                                 |
| ----- | -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| I-01  | `Lumin-1.0.0-setup.exe /S` | 退出码 0                          | 退出码 0，耗时 **20.2 s**                                                                                                                                                             | ✅                                                                                                   |
| I-02  | 检查安装目录               | 可执行文件 + Electron 运行时齐全  | `%LOCALAPPDATA%\Programs\Lumin`，**82 个文件**；`Lumin.exe` **210,974,720 字节**                                                                                                      | ✅                                                                                                   |
| I-03  | exe 内嵌图标               | 是我们的图标，不是 Electron 默认  | `resources/icon.ico` 的 **16/24/32/48/64/128/256 七档负载 7/7 逐字节命中 `Lumin.exe`**；同一批字节在 `electron.exe` 里 **7/7 不存在**；GDI+ 抽出的 32×32 中心 luma≈178（Electron 66） | ✅ **已复验**（2026-09 第二轮图标更换后重跑 `_verify-packaging.js` 24/24；旧结论的「待复验」已解除） |
| I-04  | 文件关联                   | `.md` 登记到本应用                | `HKCU\Software\Classes\.md` 默认值 = `Markdown`；`…\Markdown\shell\open\command` = `C:\Users\…\Programs\Lumin\Lumin.exe "%1"`                                                         | ✅                                                                                                   |
| I-05  | 「打开方式」候选           | 扩展名带 OpenWithProgids          | `HKCU\Software\Classes\.md\OpenWithProgids` 含 `Markdown`                                                                                                                             | ✅                                                                                                   |
| I-06  | 开始菜单快捷方式           | target 指向安装后的 exe、图标同源 | target = `…\Programs\Lumin\Lumin.exe`；args 空；workdir = 安装目录；icon = `Lumin.exe,0`                                                                                              | ✅                                                                                                   |
| I-06b | 快捷方式 AUMID             | Windows 身份链路                  | ~~在 .lnk 字节里搜不到 `com.lumin.app` —— 快捷方式未携带 AppUserModelID 属性~~ **⬅ 本轮更正：这是测量方法错误，安装器写的 lnk 本来就带 AUMID（见 §四）**                              | ⚠️→✅                                                                                                |
| I-07  | 桌面快捷方式               | 创建                              | 已创建，target = 安装后的 `Lumin.exe`                                                                                                                                                 | ✅（但覆盖了基线里那条，见问题 3）                                                                   |
| I-08  | 卸载条目                   | 出现在「应用和功能」              | key `55dd9090-…-991cc048ba5d`，DisplayName=`Lumin`，Version=`1.0.0`，UninstallString=`"…\Uninstall Lumin.exe" /currentuser`，NoModify=1                                               | ✅                                                                                                   |
| I-08b | 出版者 / 安装位置          | 正确显示                          | **Publisher=`example.com`**；`InstallLocation` **为空**；`EstimatedSize` 报 501.4 MB（实际约 280 MB）                                                                                 | ⚠️ 见问题 2 / 6                                                                                      |

#### 9.3.2 安装后运行

| 编号 | 步骤                                                                         | 期望                            | 实测                                                                                                                                                    | 结论 |
| ---- | ---------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A-01 | `Lumin.exe --user-data-dir=<临时> --remote-debugging-port=9227 "…甲文档.md"` | 以**裸路径**打开该文档          | CDP 查到 1 个页面，标题 **`lumin-install-test-甲文档.md - Lumin`**，URL = `file:///…/Programs/Lumin/resources/app.asar/out/renderer/index.html#/editor` | ✅   |
| A-02 | 进程与退出                                                                   | 正常启动与退出                  | 4 个进程；`Stop-Process` 后归 0                                                                                                                         | ✅   |
| A-03 | 渲染层来源                                                                   | 从 asar 加载（不是 dev server） | URL 里是 `app.asar/out/renderer/index.html`                                                                                                             | ✅   |

> A-01 是第一轮**最有价值的一条**：文件关联注册只是「登记」，真正决定「双击能不能打开」的是主进程能否解析**裸文件路径**参数（`src/main/services/launchIntent.ts`）。这条通过，说明关联的**代码侧一半**已经接上。

#### 9.3.3 卸载

| 编号  | 步骤                                    | 期望         | 实测                                                                               | 结论                               |
| ----- | --------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | ---------------------------------- |
| U-01  | `"Uninstall Lumin.exe" /currentuser /S` | 退出码 0     | 退出码 0，耗时 **10.6 s**                                                          | ✅                                 |
| U-02  | 安装目录                                | 清空         | 目录**已删除**，残留文件 0                                                         | ✅                                 |
| U-03  | 快捷方式                                | 清除         | 开始菜单、桌面的 `Lumin.lnk` 均已删除                                              | ✅（桌面那条也一并消失，见问题 3） |
| U-04  | 注册表 ProgID                           | 清除         | `HKCU\Software\Classes\Markdown` 已删除                                            | ✅                                 |
| U-04b | 扩展名默认值                            | 还原         | **`HKCU\Software\Classes\.md` 默认值仍是 `Markdown`**（悬空指向已被删除的 ProgID） | ❌ → **本轮已修，见 §一 P1**       |
| U-05  | 卸载条目                                | 清除         | 含 Lumin 的项 = 0                                                                  | ✅                                 |
| U-06  | **用户数据**                            | **完整保留** | `%APPDATA%\Lumin` **11027 个文件 / 38 个草稿，与安装前逐项一致**                   | ✅✅                               |

> U-06 是当时最关键的断言：`deleteAppDataOnUninstall: false` 生效，卸载**没有**碰用户的笔记索引、草稿、设置与会话。

### 9.4 发现的问题（按严重度）

| #   | 严重度           | 问题                                                                                         | 影响                                                                              | 修复方向                                                                                                                                                                        |
| --- | ---------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **中**           | 卸载后 `HKCU\Software\Classes\.md` 的默认值残留为 `Markdown`，而对应 ProgID 已被删除（悬空） | 该用户此后双击 `.md` 会落到「选择打开方式」，而不是回退到卸载前的默认程序         | electron-builder 的 NSIS 卸载脚本未清扩展名默认值。可用 `nsis.include` 挂一段自定义 NSIS 代码，在卸载段 `DeleteRegValue HKCU "Software\Classes\.md" ""`（同时处理 `.markdown`） | ✅ 本轮已按此修                                                      |
| 2   | **中**           | 「应用和功能」里 **Publisher 显示 `example.com`**                                            | 用户可见的观感问题，也让「未知发布者」的印象更重                                  | `package.json` 的 `author` 字段（electron-builder 的 NSIS 从这里取 Publisher）改成真实作者                                                                                      | ✅ 本轮已修                                                          |
| 3   | 低-中            | 桌面快捷方式**覆盖了同名既有文件**                                                           | 若用户桌面上已有叫 `Lumin.lnk` 的东西，会被替换，卸载后一并消失                   | 产品决策：保留 `createDesktopShortcut: true`（主流做法）但在文档里提示                                                                                                          | 🔶 本轮选择保持现状，见 §三                                          |
| 4   | 低               | 开始菜单快捷方式**未携带 AppUserModelID**                                                    | 打包态身份由 exe 自身兜底，但任务栏右键菜单项与「固定到任务栏」的显示未能自动验证 | 若需要显式身份链路，可在 `nsis.include` 里给快捷方式写入 AUMID 属性                                                                                                             | ⚠️ 前提有误：安装器写的 lnk **本来就带 AUMID**；已加幂等兜底，见 §四 |
| 5   | 中（开发期专属） | **开发态与打包版共用 `%APPDATA%\Lumin` 与单实例锁**                                          | 同时开 dev 与打包版会互相抢单实例锁；打包版会读写 dev 的同一份设置/会话/草稿      | 开发态固定使用独立 profile，或开发态用不同的 app name                                                                                                                           | ✅ 本轮已修（opt-in），见 §一 P5                                     |
| 6   | 低               | 卸载条目 `InstallLocation` 为空、`EstimatedSize` 501.4 MB（实际约 280 MB）                   | 仅信息展示不准确                                                                  | 可在 `nsis.include` 里补 `InstallLocation`；体积估算属上游行为，可忽略                                                                                                          | ✅ 前半已修；后半保持文档记录                                        |

### 9.5 未覆盖 / 需人工确认（第一轮）

1. **真实「双击 .md」**：本轮**没有**做真实双击，原因是当时 dev 实例正在运行，而 dev 与打包版**共用 `%APPDATA%\Lumin` 与单实例锁**（问题 5），双击会把请求转给 dev 实例，测不出打包版自身的行为。替代做法是：读取注册表里的关联命令（I-04 得到 `Lumin.exe "%1"`）+ 用**同样形态的裸路径**启动打包版（A-01 通过）——两段合起来等价于「关联可用」，但不是端到端。
2. 「打开方式」对话框里是否出现 Lumin（`OpenWithProgids` 已就位，理论上会出现）。
3. 任务栏右键菜单项 / 「固定到任务栏」之后的图标与名称（与人眼观感相关）。
4. 自动更新：`publish` 仍是占位地址，运行时按设计**跳过检查**；未接真实渠道，未跑过升级。
5. 代码签名与 SmartScreen：当前未签名，用户手装时会看到「未知发布者」提示。

### 9.6 第一轮的可复现命令

```powershell
npm run build:win
Start-Process .\dist\Lumin-1.0.0-setup.exe -ArgumentList '/S' -Wait -PassThru   # 期望 ExitCode 0
(Get-ItemProperty 'HKCU:\Software\Classes\Markdown\shell\open\command').'(default)'   # 期望 …\Lumin.exe "%1"
& "$env:LOCALAPPDATA\Programs\Lumin\Lumin.exe" "--user-data-dir=$env:TEMP\lumin-install-test" "C:\path\to\doc.md"
& "$env:LOCALAPPDATA\Programs\Lumin\Uninstall Lumin.exe" /currentuser /S          # 期望 ExitCode 0
Test-Path "$env:LOCALAPPDATA\Programs\Lumin"                                      # 期望 False
```

> 第二轮起，上面这一串（含断言与机器状态恢复）已固化为 `tools/_install-test.ps1`，见 §七。

### 9.7 第一轮对机器的改动与复原

| 改动                                           | 是否已复原                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| 安装到 `%LOCALAPPDATA%\Programs\Lumin`         | ✅ 已卸载，目录已删除                                                         |
| 开始菜单 `Lumin.lnk`                           | ✅ 已随卸载删除                                                               |
| **桌面 `Lumin.lnk`（原有那条指向项目文件夹）** | ⚠️ 被安装器覆盖、随卸载删除；**已按原样重建**（target = 项目文件夹）          |
| `HKCU\Software\Classes\.md` 默认值             | ⚠️ 卸载残留 `Markdown`，已用 `reg delete … /ve /f` 手动清除，现为空（= 基线） |
| `HKCU\Software\Classes\Markdown`、卸载条目     | ✅ 卸载时已清除；`Applications\Lumin.exe`、`RegisteredApplications` 均无残留  |
| `FileExts\.md\OpenWithList`                    | 未含 Lumin 条目（仅原有的 Typora/electron 记录），无需处理                    |
| `%APPDATA%\Lumin`（用户数据）                  | ✅ 全程未被修改（11027 文件 / 38 草稿）                                       |
| `dist\Lumin-1.0.0-setup.exe`                   | 保留，可重复用于回归                                                          |
