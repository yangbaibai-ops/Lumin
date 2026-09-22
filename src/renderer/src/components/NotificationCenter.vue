<script setup lang="ts">
// ─── 全局通知中心（顶部一条）───────────────────────────────────────────────
// 设计要点：
//  - 通知**不是长方形组件**：像 Typora 一样直接把内容展示在编辑区上方那块区域里
//    （没有背景/边框/圆角/阴影）—— 见 template 顶部注释与 overlays.css 的 `.ntf-item`；
//  - 一屏只显示一条通知（最新的），多条时用 ‹ 1/3 › 切换、可逐条或整体关闭；
//  - 级别靠「图标颜色 + 级别名」区分，不再用左侧色条或底色方块；
//  - 不自动消失：只有用户点 X / 全部关闭才收起，内容与顺序由 SQLite 持久化；
//  - 组件只读 store、只调 store 动作，不直接接触 IPC 或数据库。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NotificationLevel } from '../../../shared/types'
import { useNotificationsStore } from '../stores/notifications'
import Icon from './Icon.vue'

const { t, locale } = useI18n()
const notifications = useNotificationsStore()

/** 级别 → 图标与文字色（颜色全部走主题令牌，三套主题自动适配；无底色/无边框） */
const LEVEL: Record<NotificationLevel, { icon: string; color: string }> = {
  info: {
    icon: 'info',
    color: 'text-accent'
  },
  success: {
    icon: 'check',
    color: 'text-ok'
  },
  warning: {
    icon: 'alert-triangle',
    color: 'text-warning'
  },
  error: {
    icon: 'alert-circle',
    color: 'text-danger'
  }
}

const active = computed(() => notifications.active)
const visual = computed(() => LEVEL[active.value?.level ?? 'info'])
const total = computed(() => notifications.items.length)

/** 切换方向：驱动「上一条向左、下一条向右」的滑入动效 */
const dir = ref<'prev' | 'next'>('next')
function step(delta: number): void {
  dir.value = delta < 0 ? 'prev' : 'next'
  notifications.step(delta)
}

/** 操作按钮的视觉层级（主/次/危险），配色全部走主题令牌 */
function actionToneClass(tone?: 'primary' | 'ghost' | 'danger'): string {
  if (tone === 'primary') return 'is-primary'
  if (tone === 'danger') return 'is-danger'
  return ''
}

/** 正在执行某个按钮的动作：期间禁用按钮，避免连点造成重复创建 */
const busy = ref(false)
async function runAction(actionId: string): Promise<void> {
  const current = active.value
  if (!current || busy.value) return
  busy.value = true
  try {
    await notifications.runAction(current.id, actionId)
  } finally {
    busy.value = false
  }
}

const timeFmt = computed(
  () => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' })
)
const timeText = computed(() => (active.value ? timeFmt.value.format(active.value.createdAt) : ''))

function closeCurrent(): void {
  if (active.value) void notifications.close(active.value.id)
}
</script>

<template>
  <!-- 通知条：**直接占用编辑区上方的那块区域**，不是一个长方形组件 ——
       用户口径（承上一版）：不要「把原来的卡片原样挪到上面」，而是取消长方形样式，
       像 Typora 一样把通知内容直接展示在顶部区域里。
       所以这里没有背景/边框/圆角/阴影/毛玻璃：整块铺在编辑区上方的外壳底色上，
       一行级别色图标 + 标题，正文与操作按钮另起一行，级别·时间与翻页/关闭靠右。
       进出场动画见 overlays.css 的 `.ntf-*`（自上而下）。 -->
  <div
    class="ntf-strip pointer-events-none flex flex-none justify-center px-4 pt-3"
    data-notification-center
  >
    <Transition name="ntf">
      <section
        v-if="active"
        class="ntf-item pointer-events-auto w-full max-w-[820px] text-ink"
        role="status"
        aria-live="polite"
        data-ntf-item
      >
        <!-- 内容区：切换通知时整体横向滑入 -->
        <Transition :name="dir === 'prev' ? 'ntf-prev' : 'ntf-next'" mode="out-in">
          <div :key="active.id" class="flex items-start gap-2.5">
            <!-- 级别：只靠图标颜色区分（不再有底色方块），三套主题下都由令牌派生 -->
            <span class="mt-[3px] flex flex-none" :class="visual.color">
              <Icon :name="visual.icon" :size="14" :stroke-width="2" />
            </span>

            <div class="min-w-0 flex-1">
              <p class="ntf-title break-words text-[13.5px] font-medium leading-6 text-ink">
                {{ active.title }}
              </p>
              <p
                v-if="active.body"
                class="ntf-body mt-1 max-h-[46vh] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-ink-2"
              >
                {{ active.body }}
              </p>

              <!-- 操作按钮（可交互通知，如「创建并打开 / 取消」）：
                   点击即收起本条，再按 payload.kind 派发给注册的处理器 -->
              <div v-if="active.actions.length" class="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  v-for="a in active.actions"
                  :key="a.id"
                  class="ntf-action"
                  :class="actionToneClass(a.tone)"
                  :disabled="busy"
                  @click="runAction(a.id)"
                >
                  {{ a.label }}
                </button>
              </div>
            </div>

            <!-- 右侧：级别 · 时间 + 多条时的翻页/全部关闭 + 关闭本条（原来这些在卡片底栏） -->
            <div class="flex flex-none items-center gap-1.5 pt-px" data-ntf-meta>
              <span class="text-[11.5px]" :class="visual.color">
                {{ t(`notifications.level.${active.level}`) }}
              </span>
              <span class="text-[11.5px] text-ink-3">·</span>
              <span class="tabular-nums text-[11.5px] text-ink-3">{{ timeText }}</span>

              <template v-if="total > 1">
                <button
                  class="ntf-icon-btn !h-6 !w-6"
                  :title="t('notifications.prev')"
                  :aria-label="t('notifications.prev')"
                  @click="step(-1)"
                >
                  <Icon name="chevron-left" :size="14" />
                </button>
                <span class="tabular-nums text-[11.5px] text-ink-3" data-ntf-count>
                  {{ notifications.activeIndex + 1 }}/{{ total }}
                </span>
                <button
                  class="ntf-icon-btn !h-6 !w-6"
                  :title="t('notifications.next')"
                  :aria-label="t('notifications.next')"
                  @click="step(1)"
                >
                  <Icon name="chevron-right" :size="14" />
                </button>
                <button
                  class="ntf-text-btn"
                  :title="t('notifications.closeAll')"
                  @click="notifications.closeAll()"
                >
                  {{ t('notifications.closeAll') }}
                </button>
              </template>

              <button
                class="ntf-icon-btn"
                :title="t('notifications.close')"
                :aria-label="t('notifications.close')"
                @click="closeCurrent"
              >
                <Icon name="x" :size="15" />
              </button>
            </div>
          </div>
        </Transition>
      </section>
    </Transition>
  </div>
</template>
