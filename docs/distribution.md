# 分发链：还缺哪些外部输入，怎么一次性接上

> 这份文档只讲**只有作者能提供**的东西（仓库地址、官网、更新渠道、代码签名证书）。
> 代码侧已经全部就位并且是**一键可切换**的：拿到值 → 改一处 → 重跑自检 → 打包。
> 自检脚本：`npm run dist:check`（人看）／`npm run dist:check:release`（发版门禁，缺项即失败）。

## 1. 现状一眼看清

```bash
npm run dist:check
```

输出是一张表（`就绪 / 待填`）+ 待办清单（每项都写清"改哪里"和"缺了会怎样"）。
`shared/distribution.ts` 是**唯一判据来源**：运行时（`main/services/updater.ts` 决定"要不要真的去查更新"）
与构建前自检用的是同一个占位域名清单，不会出现"脚本说配好了、运行时却跳过检查"这种漂移。

`--release` 模式（`npm run dist:check:release`）在**任何一项未就绪**时 `exit 1`。
建议把它放在发版流程最前面 —— 免得带着 `example.com` 的更新地址发出去。

## 2. 四项外部输入（逐项照做）

### 2.1 更新渠道

**改哪**：`electron-builder.yml` 的 `publish`。

```yaml
# 方案 A：GitHub Releases（推荐，零运维）
publish:
  provider: github
  owner: <你的 GitHub 账号>
  repo: Lumin

# 方案 B：任意 HTTPS 静态目录（把安装包与 latest.yml 放上去即可）
publish:
  provider: generic
  url: https://你的域名/lumin/updates
```

**拿到之后**：`npm run build:win` → electron-builder 生成 `latest.yml` 与
`app-update.yml`（打进去的渠道配置）→ 把「安装包 + `latest.yml`」一起发布到该渠道。

**缺了会怎样**：占位地址会被 `updater` 识别并**跳过检查** —— 用户永远收不到更新，
而且不会看到任何错误提示（这是有意的：默认状态下不该冒出网络失败通知）。
应用内「自动检查更新」默认关闭，配置好渠道后由用户主动打开或我们在设置里默认打开。

### 2.2 仓库地址 / 2.3 官网（下载页）

**改哪**：`package.json`。

```json
"repository": "https://github.com/<你的账号>/Lumin",
"homepage": "https://<你的站点>/lumin",
```

**缺了会怎样**：README 与「关于」页指向不了源码；用户拿到安装包后没有可点的落地页
（错误报告、更新说明都少一个去处）。

**`private: true` 保持不动**：Lumin 不发 npm，`private` 能挡住误发；自检脚本只把它报出来让人确认。

### 2.4 Windows 代码签名证书

**改哪**：**不用改配置文件**。electron-builder 自己认这两个环境变量：

```powershell
# .pfx 文件路径（或 base64 内容）
$env:CSC_LINK = 'D:\certs\lumin.pfx'
$env:CSC_KEY_PASSWORD = '证书口令'
npm run build:win
```

- Windows 上也可以只用 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`（同名语义，只作用于 Windows）。
- 设了 → 自动签名（安装包与 exe 都签）；没设 → 产出未签名包，控制台会有跳过提示。
- 时间戳服务由 electron-builder 默认处理（签名在证书过期后仍有效）。

**缺了会怎样**：安装包未签名 ⇒ 用户首次运行看到 SmartScreen「未知发布者」警告，
企业环境可能直接拦住。签名之后，`electron-builder.yml` 里已经打开的
`nsis.verifyUpdateCodeSignature: true` 会**校验更新包的签名与发布者**，
换过包的假更新会被拒绝安装。

## 3. 便携版（免安装 + 数据随身）

```bash
npm run build:portable     # 产出 dist/Lumin-<版本>-portable.exe
```

- **免安装**：`electron-builder.yml` 的 `portable` 段（自解压到临时目录，不写注册表、不建开始菜单）。
  它**不在** `win.target` 里 —— 默认 `build:win` 只产安装包，发版时不会多出几十 MB 的产物。
- **数据随身**：便携包运行时会带上 `PORTABLE_EXECUTABLE_DIR`，`main/index.ts` 据此把 userData
  指到 **exe 同级**的 `LuminData/`（索引、草稿、设置、会话、日志全在里面）。
  判定与理由见 `src/shared/portable.ts`；不做这一步的话"绿色版"换台机器打开会像"全空了"。
  - 目录建不出来（U 盘只读/被占用）时**退回 `%APPDATA%` 并在日志里留一行** —— 应用照常能用。
  - ⚠️ **隐私**：数据跟着 U 盘走 = U 盘丢了数据就丢了，而且插到别人机器上打开时，
    你的笔记会出现在那台机器上。不想这样就直接用安装版（或把安装版装到非系统盘）。
- **验收现状（如实）**：配置通过 electron-builder 26.15.3 的 schema 校验（会进到 packaging 阶段）；
  userData 重定向有 6 条单测 + 一次**运行时实测**（带 `PORTABLE_EXECUTABLE_DIR` 启动，
  `<dir>/LuminData/` 下出现 logs/缓存/数据库）。**便携包的完整产出**归到打包手动清单
  （见 [packaging-install-test.md](./packaging-install-test.md)）：发版前补跑一次
  `npm run build:portable`，确认 `dist/Lumin-<版本>-portable.exe` 存在，双击后数据落在
  exe 同级 `LuminData/` 且卸载不留注册表项。本轮环境在 packaging 阶段被外部终止、这一步没跑完。
- 便携包与安装版的文件关联/更新：**都不做**（免安装形态不该改系统设置，也不该被静默更新）。

## 4. 发版检查清单

```bash
npm run ci                    # 类型/lint/单测/文档一致性/构建
npm run dist:check:release    # 四项外部输入是否就绪（缺项即失败）
npm run test:suites           # CDP 默认矩阵（62 条）
npm run build:win             # 打包（设了 CSC_LINK 则自动签名）
```

打包产物自检（安装、启动、图标、文件关联、裸路径打开）在
[packaging-install-test.md](./packaging-install-test.md)；那套会构建 NSIS 安装包并真装一次。

## 5. 为什么这些不做成"写死配置"

- 仓库地址与证书是**作者私有**信息：写进仓库等于把将来要改的东西埋进代码；
- 更新渠道一旦写死，切换渠道（GitHub Releases → 自建源）就要改代码 + 重新发版；
- 占位值必须**能被机器识别**，否则"发出去才发现渠道还是 example.com"这类事故只能靠人盯。

所以：值放配置/环境变量，**判据放 `shared/distribution.ts`**，检查放 `dist:check`，
运行时行为由同一份判据决定 —— 一套逻辑，三个地方用。
