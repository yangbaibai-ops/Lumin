/**
 * ─── 文件树内的「移动到文件夹」（纯规则，可单测）────────────────────────────────
 *
 * 补的是审计能力矩阵里那一格：「文件树内拖放排序/移动 | 无 | 仍无」——
 * `TreeNode.vue` 早就有 `dragstart`（把路径写进 `dataTransfer`），而 `FileTree.vue` 的
 * `onDrop` 只有一句 `preventDefault()`：行能被拿起来，却**放不下**（拖拽是个死胡同）。
 *
 * 本轮只补**一件事**：把一项移动到某个文件夹里（含工作区根）。
 * 为什么不做「任意排序」：树的顺序来自目录读取 + 名称排序，**没有可持久化的位置**，
 * 一次外部改动 / 重新读盘就全部打回原形；做一个会被打回原形的功能，收益低、承诺假。
 *
 * 「移动」不是新能力：主进程那条 `file.rename` 通道本来就是「换一个目标路径的重命名」，
 * 目标已存在时抛 `TARGET_EXISTS`（**绝不覆盖**，见 `src/main/fileOps.ts` 的 `renameEntry`）。
 * 于是这里只做两件**纯字符串**的事：
 *   ① 判定这次落点合不合法（自己 / 自己的子孙 / 同父 / 越界 / 重名）；
 *   ② 算出目标路径。
 * 真实调用方（`stores/files.ts` 的 `moveNode`）只负责跑 IPC 与收尾同步。
 *
 * ⚠️ 本模块**不读磁盘**：唯一需要「目标已存在」这条知识的地方把探测结果作为 `exists`
 * 注入 —— 单测传一个集合就能覆盖冲突分支，真实调用传一次 `file:exists` 的结果。
 * 也刻意**不引 vue**：这样 `tests/treeMove.test.mjs` 能直接加载它（纯 TS，无运行时依赖）。
 */
import type { FileNode } from '../../../shared/types'
// 目录边界判定与「路径最后一段」都复用既有唯一实现（显式 .ts：本文件会被 node --test 直接加载）
import { isInsideByString, parentDir, samePath } from '../../../shared/paths.ts'
import { baseNameOf } from './recent.ts'

/** 拒收落点的原因（每一种都要能对上一句能指导下一步的话，见 stores/files.ts 的 MOVE_REJECT_TOAST） */
export type MoveRejectReason =
  'outside-workspace' | 'into-self' | 'into-descendant' | 'target-exists'

/** 被移动的东西：只要路径与类型（够 planMove 用，也够 applyRenameFixups 用） */
export interface MoveSource {
  path: string
  type: FileNode['type']
}

/**
 * 一次移动的计划。三态而不是布尔：
 *  * `move`   —— 可以搬，目标路径已经算好；
 *  * `noop`   —— 拖回原处（同父目录）：**不产生一次无意义的 rename**，界面不发任何提示；
 *  * `reject` —— 明确不做，并给出原因（调用方按原因提示，绝不静默）。
 */
export type MovePlan =
  | { kind: 'move'; from: string; to: string; name: string; fromDir: string; toDir: string }
  | { kind: 'noop'; reason: 'same-parent'; from: string; fromDir: string }
  | { kind: 'reject'; reason: MoveRejectReason; from: string; targetDir: string }

/** 拼接「目录 + 名称」：纯字符串，不引 node:path（渲染层要能在单测里跑） */
function joinPath(dir: string, name: string): string {
  const d = dir.replace(/[\\/]+$/, '')
  // 路径一律来自主进程（原生分隔符）；这里只是给测试里的 POSIX 写法留一条正路
  const sep = d.includes('/') && !d.includes('\\') ? '/' : '\\'
  return `${d}${sep}${name}`
}

/**
 * 判定一次移动：能搬就给出目标路径，不能搬就说清为什么。
 *
 * @param source       被拖动的项（路径 + 类型）
 * @param targetDir    落点目录（工作区根也算一个合法落点）
 * @param workspaceRoot 当前工作区根；落点必须**在它之内**（含根本身）
 * @param exists       目标路径是否已存在（可选注入；不给就不查重名）。
 *   **只有它能覆盖「重名」这条规则**：真实调用方先跑一遍本函数拿到目标路径、
 *   探一次磁盘、再把结果注进来跑第二遍（见 `moveNode` 的说明）。
 */
export function planMove(
  source: MoveSource,
  targetDir: string,
  workspaceRoot: string,
  exists?: (path: string) => boolean
): MovePlan {
  const from = source.path
  const fromDir = parentDir(from)

  // ① 落点必须是工作区里的目录：树只画工作区里的东西，越界的目标只会是脏数据
  if (!workspaceRoot || !targetDir || !isInsideByString(workspaceRoot, targetDir)) {
    return { kind: 'reject', reason: 'outside-workspace', from, targetDir }
  }

  // ② 同父 = 无操作。放在最前面：拖回原处是最常见的误操作之一，
  //    它既不该报错，也不该触发一次 rename（那会白刷两个目录、还会多一张撤销卡）
  if (samePath(fromDir, targetDir)) return { kind: 'noop', reason: 'same-parent', from, fromDir }

  /**
   * ③ 目录不能进自己 / 进自己的子孙。
   *    这是**必须显式拒绝**的一条：`fs.rename('D:\\ws\\a', 'D:\\ws\\a\\b')` 在 Windows 上
   *    会以 EBUSY/EPERM 之类的系统错误失败（或更糟），用户看到的错误文案与"我拖错了吗"无关。
   *    判据用 `isInsideByString`（按目录边界比较，`C:\\ws\\a` 不把 `C:\\ws\\ab` 算内部）。
   */
  if (source.type === 'directory') {
    if (samePath(from, targetDir)) return { kind: 'reject', reason: 'into-self', from, targetDir }
    if (isInsideByString(from, targetDir)) {
      return { kind: 'reject', reason: 'into-descendant', from, targetDir }
    }
  }

  // ④ 目标路径 = 落点目录 + 原名字（移动不改名：改名有自己的入口 F2 / 右键重命名）
  const name = baseNameOf(from)
  const to = joinPath(targetDir, name)

  // ⑤ 重名：明确失败并提示，**绝不覆盖**（与主进程 renameEntry 同一条口径；
  //    这里先判一次是为了能在落盘前就说清楚，而不是靠 IPC 抛错再翻译）
  if (exists?.(to)) return { kind: 'reject', reason: 'target-exists', from, targetDir }

  return { kind: 'move', from, to, name, fromDir, toDir: targetDir }
}

/**
 * 拖拽悬停期间用的**快速**判定：这次落点值不值得高亮。
 *
 * 与 `planMove` 的唯一差别是不做重名探测（`dragover` 期间拿不到异步结果，也不该为每一次
 * 移动去发 IPC）：同名冲突会在**落下**那一刻由 `moveNode` 明确拒绝并提示。
 * 同父（无操作）与非法落点都返回 false —— 落点高亮必须只亮**真的会搬**的那些行。
 */
export function canDropOn(source: MoveSource, targetDir: string, workspaceRoot: string): boolean {
  return planMove(source, targetDir, workspaceRoot).kind === 'move'
}

// ─── 拖放会话：谁在被拖 ────────────────────────────────────────────────────────
//
// 为什么是**模块级普通变量**而不是响应式状态：落点高亮是**每一行自己的**局部状态
// （dragenter/dragleave 就在那一行上，`ui.dropTargetPath` 记高亮、容器上的 dragend 兜底清除），
// 这里只需要一个「谁在被拖」的信箱，供 `dragover` 做合法性判定 —— 它不需要参与渲染，
// 也就不该把 vue 引进来（引了 `tests/treeMove.test.mjs` 就得连 vue 一起加载）。
//
// 为什么不能用 `dataTransfer.getData`：Chromium 在 `dragover` 期间处于「受保护的数据存储」
// 模式，只有 `drop` 才读得到内容（`types` 里只有 'text/plain' 这个类型名）。所以来源路径
// 必须在 `dragstart` 时自己记下来。

let dragged: MoveSource | null = null

/** 某一行的 `dragstart`：记下来源（同时把路径写进 dataTransfer，作为**跨组件/未来**的正规通道） */
export function beginTreeDrag(source: MoveSource): void {
  dragged = { path: source.path, type: source.type }
}

/** 拖拽结束（dragend，含 Esc 取消）或落下之后：清空信箱 */
export function endTreeDrag(): void {
  dragged = null
}

/** 当前正在被拖的树行（null = 没有内部拖拽；外部拖入永远拿不到它） */
export function draggingTree(): MoveSource | null {
  return dragged
}
