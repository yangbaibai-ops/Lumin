'use strict'
// 验收：**路径授权闸**（`main/services/pathGrants`）—— 该拦的拦住，该通的照通
//
// 背景（审计 §4）：`file:read` / `file:write` / `file:exists` / `file:fileUrl` 此前只做
// `path.resolve`，渲染层任何一处注入就拿到"用户权限下的全盘任意读写"。现在加了授权表，
// 但**只收窄、不能挡正常流程** —— 所以这条套件两个方向都要验：
//
//   A. 拒绝：工作区外、没被用户选过/打开过/会话记录过的路径 → 读写都抛 PATH_NOT_AUTHORIZED；
//   B. 放行：工作区内读写、会话恢复的路径、以前打开过的文档（documents 表）、
//      用户拖入的文件（一次显式登记）、当前打开文档所在目录的**只读**（正文里的相对图片要用）。
//
// 为什么"只读"也要单独验：`isAuthorized` 分 read/write 两档，混了就等于把"拖入的文件"
// 变成"可以把任意位置写坏的入口"。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const base = path.join(os.tmpdir(), 'lumin-grants')
const ws = path.join(base, 'workspace')
/**
 * 「工作区之外」的夹具**不能放在 %TEMP% 下**：测试期 `LUMIN_TRUSTED_PATHS` 把 %TEMP% 声明成了
 * 信任范围（见 start-isolated.ps1 的说明），放那儿就永远测不出"拒绝"。这里放到用户主目录下的
 * 一次性目录（用完删掉），它不在任何授权范围内。
 */
const outside = path.join(os.homedir(), 'lumin-grants-outside')
/** 「拖入的文件」也必须放在 %TEMP% 之外，否则会被测试期的信任范围顺带放行，测不出"只读" */
const dropped = path.join(outside, 'dropped.md')

const read = (p) => `window.luminAPI.file.read(${JSON.stringify(p)}).then(() => 'ok').catch((e) => String(e.message ?? e))`
const write = (p, text) =>
  `window.luminAPI.file.write(${JSON.stringify(p)}, ${JSON.stringify(text)}).then(() => 'ok').catch((e) => String(e.message ?? e))`
const exists = (p) => `window.luminAPI.file.exists(${JSON.stringify(p)}).then((v) => 'ok:' + v).catch((e) => String(e.message ?? e))`

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('路径授权闸：工作区外拒绝（读写两侧）/ 正常流程全部放行')

  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
  fs.rmSync(outside, { recursive: true, force: true })
  fs.mkdirSync(outside, { recursive: true })
  const inWs = path.join(ws, 'inside.md')
  const inWsSub = path.join(ws, 'sub', 'nested.md')
  const outFile = path.join(outside, 'secret.md')
  const outNew = path.join(outside, 'brand-new.md')
  /** 链接激活授权（A4 用）：工作区外、且没被"打开过/会话记录过"的第三个文件 */
  const linked = path.join(outside, 'linked.md')
  fs.writeFileSync(inWs, '# inside\n', 'utf-8')
  fs.writeFileSync(inWsSub, '# nested\n', 'utf-8')
  fs.writeFileSync(outFile, '# outside\n', 'utf-8')
  fs.writeFileSync(dropped, '# dropped\n', 'utf-8')
  fs.writeFileSync(linked, '# linked\n', 'utf-8')

  try {
    // ── A. 拒绝侧：先把工作区设成 ws，则 outside 下的路径谁都没授权过 ──
    await ev(`(async () => {
      const f = window.__L.files()
      await f.setRoot(${JSON.stringify(ws)})
      await f.openPath(${JSON.stringify(inWs)})
      return 'ok'
    })()`)
    await sleep(900)

    const aRead = await ev(read(outFile))
    const aWrite = await ev(write(outNew, 'should not happen'))
    const aExists = await ev(exists(outFile))
    report.note('A 拒绝侧 ' + JSON.stringify({ aRead, aWrite, aExists }))
    report.check(
      'outside-path-read-refused',
      String(aRead).includes('PATH_NOT_AUTHORIZED'),
      `读工作区外的文件：${aRead}`
    )
    report.check(
      'outside-path-write-refused',
      String(aWrite).includes('PATH_NOT_AUTHORIZED'),
      `写工作区外的文件：${aWrite}`
    )
    report.check(
      'outside-path-exists-refused',
      String(aExists).includes('PATH_NOT_AUTHORIZED'),
      `探测工作区外的文件是否存在：${aExists}（存在性探测也是信息泄露面）`
    )
    report.check(
      'refused-write-left-no-file',
      !fs.existsSync(outNew),
      '被拒绝的写必须真的没落盘'
    )

    /**
     * ── A3. `shell:openPath` 的授权闸（审计 §4 P1「任意路径执行入口」） ──
     *
     * 这个 handler 是"把路径交给系统默认应用"的入口：此前只有扩展名黑名单，任何非可执行路径
     * 都会被交出去。现在它必须**先过路径授权**（返回 `PATH_NOT_AUTHORIZED`）。
     *
     * 为什么敢在这里调它：`outNew` 是一个**不存在**的路径，所以即使闸门被摘掉，
     * `shell.openPath` 也只会返回"文件不存在"，不会在机器上打开任何应用 —— 断言本身是安全的。
     */
    const aOpen = await ev(
      `window.luminAPI.shell.openPath(${JSON.stringify(outNew)}).then((v) => String(v)).catch((e) => String(e.message ?? e))`
    )
    report.check(
      'outside-path-shell-open-refused',
      String(aOpen).includes('PATH_NOT_AUTHORIZED'),
      `把未授权路径交给系统默认应用：${aOpen}（要拦在 openPath 之前，而不是交给系统后再报错）`
    )

    /**
     * ── A4. 链接激活的只读授权：`links:resolve` 之后**只读**放行 ──
     *
     * 用户点了正文里的链接时，渲染层会先 `links.resolve(target, baseDir)`；主进程在那一步为
     * 解析到的目标登记一条只读授权（否则 A3 的闸门会把"打开工作区外的链接目标"这个正常功能
     * 一起挡掉）。这里只验"登记"这一半，**不真的** `shell.openPath` —— 那会在用户机器上
     * 打开外部应用。
     */
    const linkBefore = await ev(read(linked))
    await ev(
      `window.luminAPI.links.resolve('linked.md', ${JSON.stringify(outside)}).then(() => 'ok')`
    )
    const linkAfter = await ev(read(linked))
    report.check(
      'link-activation-grants-readonly',
      String(linkBefore).includes('PATH_NOT_AUTHORIZED') && linkAfter === 'ok',
      `resolve 前=${linkBefore} resolve 后=${linkAfter}（用户点过的链接目标该放行只读）`
    )

    // ── B. 放行侧 1：工作区内（含子目录）读写都在 ──
    const bRead = await ev(read(inWsSub))
    const bWrite = await ev(write(inWsSub, '# nested edited\n'))
    report.note('B1 工作区内 ' + JSON.stringify({ bRead, bWrite }))
    report.check(
      'inside-workspace-read-write-allowed',
      bRead === 'ok' && bWrite === 'ok' && fs.readFileSync(inWsSub, 'utf-8').includes('edited'),
      `工作区内读写：read=${bRead} write=${bWrite}`
    )

    // ── B. 放行侧 2：以前打开过的文档（documents 表）→ 只读放行 ──
    //     制造"曾经打开过"：直接读一次它的父目录不行，改用会话语义 —— 这里走 documents 表，
    //     所以先让主进程索引它（file:read 会 upsert）。做法：临时把工作区切到 outside 读一次，
    //     再把工作区切回 ws（此时 outside 只应剩"打开过"这一条授权）。
    await ev(`(async () => { await window.__L.files().setRoot(${JSON.stringify(outside)}) ; return 'ok' })()`)
    await sleep(400)
    await ev(`(async () => { await window.__L.files().openPath(${JSON.stringify(outFile)}); return 'ok' })()`)
    await sleep(600)
    await ev(`(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}) ; return 'ok' })()`)
    // 关键：必须**离开**那篇文档（否则它是"当前打开的文档"，读写本来就该放行 —— 保存要用）。
    // 这里切回工作区里的另一篇，让 outside 那篇只剩"以前打开过"这一条授权。
    await ev(`(async () => { await window.__L.files().openPath(${JSON.stringify(inWs)}); return 'ok' })()`)
    await sleep(600)
    const b2Read = await ev(read(outFile))
    const b2Write = await ev(write(outFile, '# rewritten\n'))
    report.note('B2 打开过的文档（已不是当前文档） ' + JSON.stringify({ b2Read, b2Write }))
    report.check(
      'previously-opened-doc-is-readonly',
      b2Read === 'ok' && String(b2Write).includes('PATH_NOT_AUTHORIZED'),
      `读=${b2Read} 写=${b2Write}（"打开过"只该给只读：否则最近列表变成任意改写入口）`
    )

    // ── B. 放行侧 3：拖入的文件 —— 先申请（已存在 → 通过），再读；但**不能写** ──
    const b3Grant = await ev(
      `window.luminAPI.file.authorizeUserPath(${JSON.stringify(dropped)}).then((v) => 'ok:' + v).catch((e) => String(e.message ?? e))`
    )
    const b3Read = await ev(read(dropped))
    const b3Write = await ev(write(dropped, 'nope'))
    const b3Missing = await ev(
      `window.luminAPI.file.authorizeUserPath(${JSON.stringify(path.join(outside, 'nope.md'))}).then((v) => 'ok:' + v)`
    )
    report.note('B3 拖入 ' + JSON.stringify({ b3Grant, b3Read, b3Write, b3Missing }))
    report.check(
      'dropped-file-grant-is-readonly',
      b3Grant === 'ok:true' && b3Read === 'ok' && String(b3Write).includes('PATH_NOT_AUTHORIZED'),
      `授权=${b3Grant} 读=${b3Read} 写=${b3Write}`
    )
    report.check(
      'dropped-grant-refuses-missing-file',
      b3Missing === 'ok:false',
      `对不存在的路径申请授权：${b3Missing}（不许给"将来会存在"的路径开口子）`
    )

    // ── B. 放行侧 4：**当前打开文档所在目录只读**（正文里的相对图片要用） ──
    //     用工作区**之外**的文档来验：它的兄弟文件应当可读、不可写。
    //     （工作区内的文件本来就可写，拿它验不出 read/write 两档的区别。）
    const sibling = path.join(outside, 'sibling.md')
    fs.writeFileSync(sibling, '# sibling\n', 'utf-8')
    await ev(`(async () => { await window.__L.files().openPath(${JSON.stringify(outFile)}); return 'ok' })()`)
    await sleep(600)
    const b4Read = await ev(read(sibling))
    const b4Write = await ev(write(sibling, '# sibling rewritten\n'))
    report.note('B4 打开文档所在目录 ' + JSON.stringify({ b4Read, b4Write }))
    report.check(
      'open-doc-dir-siblings-are-readonly',
      b4Read === 'ok' && String(b4Write).includes('PATH_NOT_AUTHORIZED'),
      `打开文档的兄弟文件：读=${b4Read} 写=${b4Write}（只读，图片能加载、但不能被改写）`
    )
  } finally {
    await ev(`(async () => { await window.__L.files().setRoot(null); return 'ok' })()`).catch(() => {})
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }

  app.close()
  process.exit(report.finish())
}

main().catch((e) => fatal(e))
