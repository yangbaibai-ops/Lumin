# Lumin 安装 / 卸载链路测试报告

> 本文是「打包产物在真实 Windows 上安装、运行、卸载」的实测记录，可复现、可复用为发布前检查清单。
> 结论与发现的问题在文末汇总；所有数据均为本机实测输出，非推断。

- **测试日期**：2026-09-15
- **被测产物**：`dist/Lumin-1.0.0-setup.exe`（NSIS）
  - 体积 **123.22 MB**（129,201,471 字节）
  - SHA256 `6D8F208C421B7E38EEEBD9507B1E8B520785763898BAE7C09D774BEB8CBCD958`
  - 由 `electron-builder@26.0.12` 依据 `electron-builder.yml` 生成（配置见该文件；它是**唯一配置真相源**）
- **环境**：Windows 11 / PowerShell 5.1 / 用户级安装（`perMachine: false`，免管理员）
- **结论**：**有条件通过** —— 安装、启动、文件关联、卸载的**主链路全部符合预期**，用户数据在卸载后**完整保留**；但有 **1 个中severity 缺陷（卸载残留注册表）** 和 4 项待修/待确认项，见「发现的问题」。

---

## 一、测试范围

| 覆盖 | 不覆盖 |
| --- | --- |
| 静默安装与退出码、安装目录结构 | 图形化安装向导的界面（本轮用 `/S` 静默跑） |
| exe 内嵌图标、文件关联注册、快捷方式、卸载条目 | 真实「双击 .md」（原因见 §五） |
| 静默卸载、注册表清理、用户数据保留 | 自动更新（`publish` 仍是占位地址） |
| 安装后 exe 以**裸文件路径**启动并打开文档 | 代码签名 / SmartScreen 表现；非 Windows 平台 |

---

## 二、安装前基线（用于判断「改动」与「残留」）

| 项 | 基线值 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\Lumin` | 不存在 |
| 开始菜单 `Lumin.lnk` | 不存在（开发态那条叫 `Lumin (dev).lnk`） |
| 桌面 `Lumin.lnk` | **存在，但指向 `D:\code_workspace\Lumin`（项目文件夹）** |
| `HKCU\Software\Classes\.md` 默认值 | 空（无关联） |
| 卸载条目（含 Lumin） | 0 项 |
| `%APPDATA%\Lumin`（用户数据） | 存在，**11027 个文件 / 38 个草稿** |

---

## 三、用例与结果

### 3.1 安装

| 编号 | 步骤 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| I-01 | `Lumin-1.0.0-setup.exe /S` | 退出码 0 | 退出码 0，耗时 **20.2 s** | ✅ |
| I-02 | 检查安装目录 | 可执行文件 + Electron 运行时齐全 | `%LOCALAPPDATA%\Programs\Lumin`，**82 个文件**；`Lumin.exe` **210,974,720 字节** | ✅ |
| I-03 | exe 内嵌图标 | 是我们的图标，不是 Electron 默认 | `resources/icon.ico` 的 **16/24/32/48/64/128/256 七档负载 7/7 逐字节命中 `Lumin.exe`**；同一批字节在 `electron.exe` 里 **7/7 不存在** | ✅ |
| I-04 | 文件关联 | `.md` 登记到本应用 | `HKCU\Software\Classes\.md` 默认值 = `Markdown`；`…\Markdown\shell\open\command` = `C:\Users\…\Programs\Lumin\Lumin.exe "%1"` | ✅ |
| I-05 | 「打开方式」候选 | 扩展名带 OpenWithProgids | `HKCU\Software\Classes\.md\OpenWithProgids` 含 `Markdown` | ✅ |
| I-06 | 开始菜单快捷方式 | target 指向安装后的 exe、图标同源 | target = `…\Programs\Lumin\Lumin.exe`；args 空；workdir = 安装目录；icon = `Lumin.exe,0` | ✅ |
| I-06b | 快捷方式 AUMID | Windows 身份链路 | **在 .lnk 字节里搜不到 `com.lumin.app`** —— 快捷方式未携带 AppUserModelID 属性 | ⚠️ 见问题 4 |
| I-07 | 桌面快捷方式 | 创建 | 已创建，target = 安装后的 `Lumin.exe` | ✅（但覆盖了基线里那条，见问题 3） |
| I-08 | 卸载条目 | 出现在「应用和功能」 | key `55dd9090-…-991cc048ba5d`，DisplayName=`Lumin`，Version=`1.0.0`，UninstallString=`"…\Uninstall Lumin.exe" /currentuser`，NoModify=1 | ✅ |
| I-08b | 出版者 / 安装位置 | 正确显示 | **Publisher=`example.com`**；`InstallLocation` **为空**；`EstimatedSize` 报 501.4 MB（实际约 280 MB） | ⚠️ 见问题 2 / 6 |

### 3.2 安装后运行

| 编号 | 步骤 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| A-01 | `Lumin.exe --user-data-dir=<临时> --remote-debugging-port=9227 "…甲文档.md"` | 以**裸路径**打开该文档 | CDP 查到 1 个页面，标题 **`lumin-install-test-甲文档.md - Lumin`**，URL = `file:///…/Programs/Lumin/resources/app.asar/out/renderer/index.html#/editor` | ✅ |
| A-02 | 进程与退出 | 正常启动与退出 | 4 个进程；`Stop-Process` 后归 0 | ✅ |
| A-03 | 渲染层来源 | 从 asar 加载（不是 dev server） | URL 里是 `app.asar/out/renderer/index.html` | ✅ |

> A-01 是本轮**最有价值的一条**：文件关联注册只是「登记」，真正决定「双击能不能打开」的是主进程能否解析**裸文件路径**参数（`src/main/services/launchIntent.ts`）。这条通过，说明关联的**代码侧一半**已经接上。

### 3.3 卸载

| 编号 | 步骤 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| U-01 | `"Uninstall Lumin.exe" /currentuser /S` | 退出码 0 | 退出码 0，耗时 **10.6 s** | ✅ |
| U-02 | 安装目录 | 清空 | 目录**已删除**，残留文件 0 | ✅ |
| U-03 | 快捷方式 | 清除 | 开始菜单、桌面的 `Lumin.lnk` 均已删除 | ✅（桌面那条也一并消失，见问题 3） |
| U-04 | 注册表 ProgID | 清除 | `HKCU\Software\Classes\Markdown` 已删除 | ✅ |
| U-04b | 扩展名默认值 | 还原 | **`HKCU\Software\Classes\.md` 默认值仍是 `Markdown`**（悬空指向已被删除的 ProgID） | ❌ 见问题 1 |
| U-05 | 卸载条目 | 清除 | 含 Lumin 的项 = 0 | ✅ |
| U-06 | **用户数据** | **完整保留** | `%APPDATA%\Lumin` **11027 个文件 / 38 个草稿，与安装前逐项一致** | ✅✅ |

> U-06 是本次最关键的断言：`deleteAppDataOnUninstall: false` 生效，卸载**没有**碰用户的笔记索引、草稿、设置与会话。

---

## 四、发现的问题（按严重度）

| # | 严重度 | 问题 | 影响 | 修复方向 |
| --- | --- | --- | --- | --- |
| 1 | **中** | 卸载后 `HKCU\Software\Classes\.md` 的默认值残留为 `Markdown`，而对应 ProgID 已被删除（悬空） | 该用户此后双击 `.md` 会落到「选择打开方式」，而不是回退到卸载前的默认程序 | electron-builder 的 NSIS 卸载脚本未清扩展名默认值。可用 `nsis.include` 挂一段自定义 NSIS 代码，在卸载段 `DeleteRegValue HKCU "Software\Classes\.md" ""`（同时处理 `.markdown`）；或向上游反馈 |
| 2 | **中** | 「应用和功能」里 **Publisher 显示 `example.com`** | 用户可见的观感问题，也让「未知发布者」的印象更重 | `package.json` 的 `author` 字段（electron-builder 的 NSIS 从这里取 Publisher）改成真实作者；或 yml 里显式 `win.publisherName` |
| 3 | 低-中 | 桌面快捷方式**覆盖了同名既有文件** | 若用户桌面上已有叫 `Lumin.lnk` 的东西（本轮基线正是「指向项目文件夹」的那条），会被替换，卸载后一并消失 | 产品决策：保留 `createDesktopShortcut: true`（主流做法）但在文档/安装说明里提示；或改为 `false` 只建开始菜单；至少要在发布说明里写明 |
| 4 | 低 | 开始菜单快捷方式**未携带 AppUserModelID** | 打包态身份由 exe 自身兜底（窗口标题/图标/任务栏按钮均正确，见 I-03/A-01），但**任务栏右键菜单项与「固定到任务栏」的显示**未能自动验证 | 若需要与开发态一致的显式身份链路，可在 `nsis.include` 里给快捷方式写入 AUMID 属性；否则保持现状并由人眼确认一次 |
| 5 | 中（开发期专属） | **开发态与打包版共用 `%APPDATA%\Lumin` 与单实例锁** | 同时开 dev 与打包版会互相抢单实例锁；打包版会读写 dev 的同一份设置/会话/草稿 | 开发态固定使用独立 profile（例如 `npm run dev` 传 `--user-data-dir=…\lumin-dev`），或开发态用不同的 app name |
| 6 | 低 | 卸载条目 `InstallLocation` 为空、`EstimatedSize` 501.4 MB（实际约 280 MB） | 仅信息展示不准确 | 可在 `nsis.include` 里补 `InstallLocation`；体积估算属上游行为，可忽略 |

---

## 五、未覆盖 / 需人工确认

1. **真实「双击 .md」**：本轮**没有**做真实双击，原因是当时你的 dev 实例正在运行，而 dev 与打包版**共用 `%APPDATA%\Lumin` 与单实例锁**（问题 5），双击会把请求转给 dev 实例，测不出打包版自身的行为。替代做法是：读取注册表里的关联命令（I-04 得到 `Lumin.exe "%1"`）+ 用**同样形态的裸路径**启动打包版（A-01 通过）——两段合起来等价于「关联可用」，但不是端到端。**要端到端验：关掉 dev 实例后再双击一个 `.md`。**
2. 「打开方式」对话框里是否出现 Lumin（`OpenWithProgids` 已就位，理论上会出现）。
3. 任务栏右键菜单项 / 「固定到任务栏」之后的图标与名称（与人眼观感相关）。
4. 自动更新：`publish` 仍是占位地址，运行时按设计**跳过检查**；未接真实渠道，未跑过升级。
5. 代码签名与 SmartScreen：当前未签名，用户手装时会看到「未知发布者」提示。

---

## 六、可复现命令（发布前检查清单）

```powershell
# 0) 构建产物（需先 npm run build）
npm run build:win

# 1) 记录基线
Get-ChildItem "$env:APPDATA\Lumin" -Recurse -File | Measure-Object          # 用户数据文件数
(Get-ItemProperty 'HKCU:\Software\Classes\.md' -EA SilentlyContinue).'(default)'

# 2) 静默安装并验证
Start-Process .\dist\Lumin-1.0.0-setup.exe -ArgumentList '/S' -Wait -PassThru   # 期望 ExitCode 0
(Get-ItemProperty 'HKCU:\Software\Classes\Markdown\shell\open\command').'(default)'   # 期望 …\Lumin.exe "%1"
$sh = New-Object -ComObject WScript.Shell
$sh.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Lumin.lnk").TargetPath

# 3) 裸路径启动（用隔离 profile，避免碰到开发实例）
& "$env:LOCALAPPDATA\Programs\Lumin\Lumin.exe" "--user-data-dir=$env:TEMP\lumin-install-test" "C:\path\to\doc.md"

# 4) 静默卸载并验证
& "$env:LOCALAPPDATA\Programs\Lumin\Uninstall Lumin.exe" /currentuser /S          # 期望 ExitCode 0
Test-Path "$env:LOCALAPPDATA\Programs\Lumin"                                      # 期望 False
(Get-ItemProperty 'HKCU:\Software\Classes\.md' -EA SilentlyContinue).'(default)'  # 期望空（当前会残留 Markdown → 问题 1）
Get-ChildItem "$env:APPDATA\Lumin" -Recurse -File | Measure-Object                # 期望与基线一致
```

**建议并入自动化**：I-04 / I-06 / U-06 / A-01 四条加进 `tools/_verify-packaging.js`（需要写注册表与安装目录，可作为「可选：安装级」用例，默认跳过、显式开关才跑）。

---

## 七、本轮测试对机器的改动与复原

| 改动 | 是否已复原 |
| --- | --- |
| 安装到 `%LOCALAPPDATA%\Programs\Lumin` | ✅ 已卸载，目录已删除 |
| 开始菜单 `Lumin.lnk` | ✅ 已随卸载删除 |
| **桌面 `Lumin.lnk`（原有那条指向项目文件夹）** | ⚠️ 被安装器覆盖、随卸载删除；**已按原样重建**（target = 项目文件夹） |
| `HKCU\Software\Classes\.md` 默认值 | ⚠️ 卸载残留 `Markdown`，已用 `reg delete … /ve /f` 手动清除，现为空（= 基线） |
| `HKCU\Software\Classes\Markdown`、卸载条目 | ✅ 卸载时已清除；`Applications\Lumin.exe`、`RegisteredApplications` 均无残留 |
| `FileExts\.md\OpenWithList` | 未含 Lumin 条目（仅原有的 Typora/electron 记录），无需处理 |
| `%APPDATA%\Lumin`（用户数据） | ✅ 全程未被修改（11027 文件 / 38 草稿） |
| `dist\Lumin-1.0.0-setup.exe` | 保留，可重复用于回归 |
