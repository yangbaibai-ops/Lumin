// `src/shared/backup.ts`：备份策略的纯函数（审计 §2 P1）。
//
// 这些函数的错法都是**静默的**：
//   * `planBackupPrune` 算错 → 删掉用户唯一那份备份，或者备份目录无限膨胀；
//   * `isBackupDue` 算错 → 要么每次启动都多一份，要么永远不备；
//   * `snapshotSkipReason` 判错 → 快照里混进 `node_modules`，或者**漏掉用户的稿件**；
//   * `snapshotEntryName` 用了反斜杠 → 解压出来是名字里带 `\` 的怪文件。
// 所以逐条钉住，包括那些"看起来不该发生"的输入（老 profile 没有这两个键、
// 用户手改设置写成字符串、时钟被往回调）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKUP_KEEP,
  DEFAULT_BACKUP_SUBDIR,
  SNAPSHOT_MAX_FILE_BYTES,
  backupPolicy,
  backupStamp,
  dbBackupName,
  formatBytes,
  isBackupDue,
  isDbBackupName,
  planBackupPrune,
  snapshotEntryName,
  snapshotSkipReason,
  workspaceSnapshotName
} from '../src/shared/backup.ts'
import { TEMP_SUFFIX_RE, isTempFileName } from '../src/shared/tempName.ts'

test('backupStamp：本地时间、可排序、零填充（文件名里要能直接比大小）', () => {
  assert.equal(backupStamp(new Date(2026, 0, 5, 9, 7)), '20260105-0907')
  assert.equal(backupStamp(new Date(2026, 11, 31, 23, 59)), '20261231-2359')
  // 字典序 = 时间序（轮换就靠这一条）
  const a = backupStamp(new Date(2026, 8, 24, 15, 30))
  const b = backupStamp(new Date(2026, 8, 24, 15, 31))
  const c = backupStamp(new Date(2026, 8, 25, 0, 0))
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`)
})

test('文件名：库备份与工作区快照各一套，且能被 isDbBackupName 认出', () => {
  const d = new Date(2026, 8, 24, 15, 30)
  assert.equal(dbBackupName(d), 'lumin-20260924-1530.db')
  assert.equal(workspaceSnapshotName(d), 'lumin-workspace-20260924-1530.zip')
  assert.equal(isDbBackupName(dbBackupName(d)), true)
  // 别人的文件 / 快照 zip / 少一位数字：都不能被当成"我们的备份"去轮换
  for (const name of [
    'lumin.db',
    'lumin.db-wal',
    'lumin-20260924-1530.zip',
    'lumin-2026092-1530.db',
    'backup.db',
    'lumin-20260924-1530.db.bak',
    'lumin-20260924-1530.db-wal'
  ]) {
    assert.equal(isDbBackupName(name), false, `${name} 不该被认成库备份`)
  }
})

test('planBackupPrune：只删最旧的、达到上限就不删、别人的文件一律不碰', () => {
  const names = (stamps) => stamps.map((s) => `lumin-${s}.db`)
  // 8 份、保留 7 → 删最旧那 1 份
  assert.deepEqual(
    planBackupPrune(
      names([
        '20260101-0000',
        '20260102-0000',
        '20260103-0000',
        '20260104-0000',
        '20260105-0000',
        '20260106-0000',
        '20260107-0000',
        '20260108-0000'
      ])
    ),
    ['lumin-20260101-0000.db']
  )
  // 正好等于上限：一份都不删（边界，off-by-one 最容易错在这里）
  assert.deepEqual(planBackupPrune(names(['20260101-0000', '20260102-0000']), 2), [])
  assert.deepEqual(planBackupPrune(names(['20260101-0000', '20260102-0000']), 3), [])
  // 超过：一次删干净，且**从旧到新**
  assert.deepEqual(planBackupPrune(names(['20260103-0000', '20260101-0000', '20260102-0000']), 1), [
    'lumin-20260101-0000.db',
    'lumin-20260102-0000.db'
  ])
  // 目录里混着用户自己的文件和快照 zip：只数我们的
  assert.deepEqual(
    planBackupPrune(['lumin.db', 'lumin-workspace-20260101-0000.zip', 'notes.txt'], 1),
    []
  )
  assert.deepEqual(planBackupPrune([], 1), [])
  // keep = 0（配置被写坏）时不会崩，但也不该把目录清空到负数 —— 全部删掉是等价的
  assert.equal(planBackupPrune(names(['20260101-0000']), 0).length, 1)
  assert.equal(BACKUP_KEEP, 7)
})

test('isBackupDue：没备过就备、到点才备、时钟往回调时不备', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 1_800_000_000_000
  assert.equal(isBackupDue(null, now), true)
  assert.equal(isBackupDue(0, now), true)
  assert.equal(isBackupDue(undefined, now), true)
  assert.equal(isBackupDue(now - day, now), true, '刚好一天：算到点')
  assert.equal(isBackupDue(now - day + 1, now), false, '差 1 毫秒：还没到')
  assert.equal(isBackupDue(now - 3 * day, now), true)
  // 时钟被往回调（用户改了系统时间 / 换了时区）：不能变成"每次启动都备一份"
  assert.equal(isBackupDue(now + day, now), false)
  // 自定义间隔（界面上的策略若以后可调，这里先钉住语义）
  assert.equal(isBackupDue(now - 3600_000, now, 3600_000), true)
  assert.equal(isBackupDue(now - 3600_000 + 5, now, 3600_000), false)
})

test('backupPolicy：老 profile 缺键 = 默认开、默认目录；坏值不许变成怪路径', () => {
  // 老 profile（存下来的 JSON 里根本没有这两个键）
  assert.deepEqual(backupPolicy({}), { dir: null, auto: true })
  assert.deepEqual(backupPolicy(null), { dir: null, auto: true })
  assert.deepEqual(backupPolicy(undefined), { dir: null, auto: true })
  // 只有显式 false 才是关
  assert.deepEqual(backupPolicy({ backupAuto: false }), { dir: null, auto: false })
  assert.equal(backupPolicy({ backupAuto: true }).auto, true)
  // 目录：空串/空白/非字符串都当作"没设"
  assert.equal(backupPolicy({ backupDir: '' }).dir, null)
  assert.equal(backupPolicy({ backupDir: '   ' }).dir, null)
  assert.equal(backupPolicy({ backupDir: 42 }).dir, null)
  assert.equal(backupPolicy({ backupDir: null }).dir, null)
  // 正常路径去掉首尾空白（用户从资源管理器复制粘贴常带空格）
  assert.equal(backupPolicy({ backupDir: '  D:\\Lumin 备份  ' }).dir, 'D:\\Lumin 备份')
})

test('snapshotSkipReason：跳过隐藏/临时/超大，但绝不误伤稿件', () => {
  // 该收录的
  assert.equal(snapshotSkipReason('a.md', 1024), null)
  assert.equal(snapshotSkipReason('秋天.md', 0), null)
  assert.equal(snapshotSkipReason('img', 0, true), null)
  assert.equal(snapshotSkipReason('a.md', SNAPSHOT_MAX_FILE_BYTES), null, '刚好等于上限：收录')
  // 隐藏目录与点文件
  assert.equal(snapshotSkipReason('.git', 0, true), 'hidden')
  assert.equal(snapshotSkipReason('.obsidian', 0, true), 'hidden')
  assert.equal(snapshotSkipReason('.DS_Store', 12), 'hidden')
  // node_modules（目录维度）
  assert.equal(snapshotSkipReason('node_modules', 0, true), 'hidden')
  // 我们自己的写盘临时文件（里面是半写状态的全文副本）
  assert.equal(snapshotSkipReason('note.md.a1b2c3d4.lumin-tmp', 100), 'temp')
  // 超大文件
  assert.equal(snapshotSkipReason('movie.mp4', SNAPSHOT_MAX_FILE_BYTES + 1), 'huge')
  // 名字里含 "lumin-tmp" 但不是我们的形状（用户自己这么命名的文件）：必须收录
  assert.equal(snapshotSkipReason('note.md.lumin-tmp', 100), null)
  assert.equal(snapshotSkipReason('note.md.zzzzzzzz.lumin-tmp', 100), null)
})

test('临时文件名的模式只有一份实现（fileOps 与快照共用 shared/tempName.ts）', () => {
  assert.equal(isTempFileName('a.md.0123abcd.lumin-tmp'), true)
  assert.equal(isTempFileName('A.MD.0123ABCD.LUMIN-TMP'), true, '大小写不敏感')
  assert.equal(isTempFileName('a.md.0123abc.lumin-tmp'), false, '不足 8 位')
  assert.equal(isTempFileName('a.md.lumin-tmp'), false)
  assert.equal(TEMP_SUFFIX_RE.test('x.ffffffff.lumin-tmp'), true)
})

test('snapshotEntryName：ZIP 里必须是正斜杠（反斜杠会变成文件名的一部分）', () => {
  assert.equal(snapshotEntryName('', 'a.md'), 'a.md')
  assert.equal(snapshotEntryName('notes', 'a.md'), 'notes/a.md')
  assert.equal(snapshotEntryName('notes/2026', 'a.md'), 'notes/2026/a.md')
  assert.ok(!snapshotEntryName('notes/deep', 'a.md').includes('\\'))
})

test('formatBytes：人读格式（设置界面的"释放了多少"与备份体积共用）', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB')
  // 坏值不许显示成 "NaN MB"
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatBytes(Number.NaN), '0 B')
  assert.equal(DEFAULT_BACKUP_SUBDIR, 'backups')
})
