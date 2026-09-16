import { defineStore } from 'pinia'
import type { WorkspaceDoc } from '../../../shared/types'
import { useFilesStore } from './files'

/**
 * ─── 工作区文章的「列表视图」缓存（从 files store 拆出来的第二块）──────────────
 *
 * 为什么单独一个 store：这是一份**派生缓存**（主进程递归扫描的结果），生命周期与
 * 「当前文档 + 文件树」完全不同：
 *   * 它的失效条件是「工作区结构变了 / 某篇保存了」，与文档状态无关；
 *   * 它只有一个消费者（`FileList.vue`），却被塞进 files store，和文档、草稿、编码、
 *     历史混在一起 —— files store 因此膨胀到 600+ 行，且这块缓存几乎测不到。
 * 拆开之后：files store 只留「文件树 + 当前文档 + 草稿/自动保存」，这边的失效世代独立演进。
 *
 * 与 files store 的关系是**单向**的：这里读 `files.root`，files store 不反向依赖本 store 的
 * 状态，只在结构变化时调用 `invalidate()` / `bumpMtime()`（Pinia 里跨 store 调用是常规做法）。
 */
export const useWorkspaceDocsStore = defineStore('workspaceDocs', {
  state: () => ({
    /** 文章列表（含 mtime 与正文预览） */
    docs: [] as WorkspaceDoc[],
    /** 失效世代：工作区结构变化 / 保存后自增，列表组件据此重扫 */
    epoch: 0,
    /** 上次成功扫描所对应的世代（避免同世代重复扫描） */
    lastEpoch: -1,
    loading: false
  }),
  actions: {
    /**
     * 标记列表失效（工作区结构变化、新建/删除/重命名、保存后修改时间变化都算）。
     * 只自增世代，不立刻扫描 —— 扫描是消费方按需触发的（列表视图可能根本没打开）。
     */
    invalidate(): void {
      this.epoch++
    },
    /**
     * 扫描当前工作区的全部 Markdown 文章。
     * 两个去重条件：同世代不重复扫；扫描期间世代变了则丢弃结果（避免用旧数据覆盖新状态）。
     */
    async load(): Promise<void> {
      const files = useFilesStore()
      if (!files.root || this.loading) return
      const root = files.root
      const epoch = this.epoch
      if (this.docs.length && epoch === this.lastEpoch) return
      this.loading = true
      try {
        const docs: WorkspaceDoc[] = await window.luminAPI.file.scanWorkspace(root)
        // 扫描期间工作区换了或又失效了 → 丢掉这批结果，等下一次触发
        if (files.root === root && this.epoch === epoch) {
          this.docs = docs
          this.lastEpoch = epoch
        }
      } finally {
        this.loading = false
      }
    },
    /** 某篇文档刚保存：就地刷新它的修改时间并按时间重排（不重扫整个工作区） */
    bumpMtime(path: string): void {
      const now = Date.now()
      let hit = false
      for (const d of this.docs) {
        if (d.path === path) {
          d.mtimeMs = now
          hit = true
        }
      }
      if (!hit) return
      this.docs = [...this.docs].sort(
        (a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || a.name.localeCompare(b.name, 'zh-CN')
      )
    },
    /** 工作区被关掉/换掉：清空缓存并失效 */
    reset(): void {
      this.docs = []
      this.epoch++
      this.lastEpoch = -1
    }
  }
})
