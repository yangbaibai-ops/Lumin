import { defineStore } from 'pinia'
import type {
  AppNotification,
  NotificationInput,
  NotificationLevel,
  NotificationPatch
} from '../../../shared/types'
import { dispatchNotificationAction } from '../lib/notificationActions'

/** 是否已订阅主进程广播（模块级，避免重复订阅） */
let changeSubscribed = false

/**
 * ─── 通知中心 store（窗口私有）─────────────────────────────────────────────
 * 职责：持有「本窗口未关闭通知」的内存镜像，并把每次变更同步到 SQLite（主进程）。
 * 数据流是单向的：store 是唯一入口 → IPC → 数据库；UI（NotificationCenter.vue）
 * 只读 store 并调用其动作，不直接碰 IPC，也无需知道持久化细节。
 *
 * 隔离：通知属于产生它的那个窗口。主进程按 IPC 发送方（event.sender）反查窗口作用域
 * （src/main/services/windowScope.ts），列表/关闭/清理全部带作用域条件，变更信号也只
 * 回给发起窗口——因此本 store 拿到的永远只是本窗口的通知（渲染进程无需也传不了作用域）。
 *
 * 为什么不是「toast 队列」：需求要求通知不自动消失、单卡片展示、可上下切换、
 * 可逐条或整体关闭，并且跨会话保留——这是「通知中心」而不是瞬时提示，故：
 *  - 列表按创建时间倒序（index 0 = 最新，默认展示的就是它）；
 *  - activeId 指向当前展示的那条，关闭后自动落到相邻的一条；
 *  - 同一个 mergeKey 的通知会被更新并置顶，避免「保存 50 次 = 50 条记录」。
 */
export const useNotificationsStore = defineStore('notifications', {
  state: () => ({
    /** 未关闭通知（最新在前） */
    items: [] as AppNotification[],
    /** 当前展示的通知 id；null = 由 items[0] 兜底 */
    activeId: null as number | null,
    /** 首次 hydrate 是否完成（避免启动瞬间闪一下空态） */
    ready: false
  }),
  getters: {
    /** 是否还有通知 */
    hasAny(state): boolean {
      return state.items.length > 0
    },
    /** 当前展示的索引（越界时钳到合法范围） */
    activeIndex(state): number {
      if (!state.items.length) return -1
      const i = state.items.findIndex((n) => n.id === state.activeId)
      return i >= 0 ? i : 0
    },
    /** 当前展示的通知 */
    active(state): AppNotification | null {
      if (!state.items.length) return null
      const i = state.items.findIndex((n) => n.id === state.activeId)
      return state.items[i >= 0 ? i : 0]
    }
  },
  actions: {
    /** 启动时从数据库恢复本窗口未关闭的通知（已关闭的不会回来） */
    async hydrate(): Promise<void> {
      // 本窗口内的变更（含其它视图/动作触发的）由主进程回信，收到后重新对齐列表；
      // 其它窗口的增删改不会发到这里——通知是按窗口作用域隔离的。
      if (!changeSubscribed) {
        changeSubscribed = true
        window.luminAPI.events.on('notifications:changed', () => void this.hydrate())
      }
      try {
        const rows = await window.luminAPI.notifications.list()
        this.items = rows
        if (this.activeId == null || !rows.some((n) => n.id === this.activeId)) {
          this.activeId = rows[0]?.id ?? null
        }
      } catch {
        /* 数据库不可用时保持空列表，不影响启动 */
      } finally {
        this.ready = true
      }
    },

    /**
     * 新建通知（默认置顶展示）。
     * 传 actions + payload 即为「需要用户作答」的可交互通知：卡片会渲染按钮，
     * 点击后由 lib/notificationActions.ts 的注册表按 payload.kind 派发。
     * @param input level/title/body/actions/payload/mergeKey
     */
    async notify(input: NotificationInput): Promise<AppNotification | null> {
      const title = input.title.trim()
      if (!title) return null
      const level: NotificationLevel = input.level ?? 'info'
      const actions = input.actions ?? []
      try {
        const saved = await window.luminAPI.notifications.add({
          level,
          title,
          body: input.body ?? '',
          actions,
          payload: input.payload,
          mergeKey: input.mergeKey
        })
        this.items = [saved, ...this.items.filter((n) => n.id !== saved.id)]
        this.activeId = saved.id
        return saved
      } catch {
        // 落库失败时退化为「仅本次会话可见」，避免通知彻底丢失
        const fallback: AppNotification = {
          id: -Date.now(),
          level,
          title,
          body: input.body ?? '',
          actions,
          payload: input.payload ?? null,
          createdAt: Date.now(),
          closedAt: null
        }
        this.items = [fallback, ...this.items]
        this.activeId = fallback.id
        return fallback
      }
    },

    /**
     * 点击卡片上的操作按钮：先收起卡片（问题已作答），再按 payload.kind 派发。
     * 未注册处理器时只收起卡片，不留下「点了没反应」的死按钮。
     */
    async runAction(id: number, actionId: string): Promise<void> {
      const item = this.items.find((n) => n.id === id)
      if (!item || !item.actions.some((a) => a.id === actionId)) return
      await this.close(id)
      await dispatchNotificationAction(item, actionId)
    },

    /** 编辑已有通知（标题/详情/级别） */
    async update(id: number, patch: NotificationPatch): Promise<void> {
      const saved = await window.luminAPI.notifications.update(id, patch).catch(() => null)
      if (!saved) return
      this.items = this.items.map((n) => (n.id === id ? saved : n))
    },

    /** 关闭单条：关闭当前项后自动展示相邻的一条（优先更新的一条） */
    async close(id: number): Promise<void> {
      const index = this.items.findIndex((n) => n.id === id)
      this.items = this.items.filter((n) => n.id !== id)
      if (this.activeId === id) {
        const next = this.items[Math.min(index, this.items.length - 1)]
        this.activeId = next?.id ?? null
      }
      if (id > 0) await window.luminAPI.notifications.close(id).catch(() => {})
    },

    /** 一并关闭（清空通知中心） */
    async closeAll(): Promise<void> {
      this.items = []
      this.activeId = null
      await window.luminAPI.notifications.closeAll().catch(() => {})
    },

    /** 物理删除（含已关闭记录；通知中心里等价于关闭） */
    async remove(id: number): Promise<void> {
      await this.close(id)
      if (id > 0) await window.luminAPI.notifications.remove(id).catch(() => {})
    },

    /** 切换展示：delta = -1 上一条（更新） / +1 下一条（更旧） */
    step(delta: number): void {
      if (this.items.length < 2) return
      const size = this.items.length
      const from = this.activeIndex < 0 ? 0 : this.activeIndex
      const to = (from + delta + size) % size
      this.activeId = this.items[to].id
    },

    /** 直接展示某条 */
    select(id: number): void {
      if (this.items.some((n) => n.id === id)) this.activeId = id
    }
  }
})
