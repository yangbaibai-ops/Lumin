<script setup lang="ts">
// ─── 全局通知中心（单卡片）─────────────────────────────────────────────────
// 设计要点：
//  - 一屏只显示一条通知（最新的），多条时用 ‹ 1/3 › 切换、可逐条或整体关闭；
//  - 级别靠「图标 + 级别名」区分，不再用左侧色条（图标底色/文字色由主题令牌派生）；
//  - 不自动消失：只有用户点 X / 全部关闭才收起，内容与顺序由 SQLite 持久化；
//  - 组件只读 store、只调 store 动作，不直接接触 IPC 或数据库。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NotificationLevel } from '../../../shared/types'
import { useNotificationsStore } from '../stores/notifications'
import Icon from './Icon.vue'

const { t, locale } = useI18n()
const notifications = useNotificationsStore()

/** 级别 → 图标与配色（tint 用主题令牌 color-mix，随三套主题自动适配） */
const LEVEL: Record<NotificationLevel, { icon: string; tint: string; color: string }> = {
  info: {
    icon: 'info',
    tint: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]',
    color: 'text-accent'
  },
  success: {
    icon: 'check',
    tint: 'bg-[color-mix(in_srgb,var(--ok)_16%,transparent)]',
    color: 'text-ok'
  },
  warning: {
    icon: 'alert-triangle',
    tint: 'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)]',
    color: 'text-warning'
  },
  error: {
    icon: 'alert-circle',
    tint: 'bg-[color-mix(in_srgb,var(--danger)_15%,transparent)]',
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

const timeFmt = computed(
  () => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' })
)
const timeText = computed(() => (active.value ? timeFmt.value.format(active.value.createdAt) : ''))

function closeCurrent(): void {
  if (active.value) void notifications.close(active.value.id)
}
</script>

<template>
  <div class="pointer-events-none fixed bottom-12 right-4 z-[200] flex justify-end">
    <Transition name="ntf">
      <section
        v-if="active"
        class="ntf-card pointer-events-auto flex min-h-[104px] w-[min(384px,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border border-edge text-ink"
        role="status"
        aria-live="polite"
      >
        <!-- 内容区：切换通知时整体横向滑入 -->
        <Transition :name="dir === 'prev' ? 'ntf-prev' : 'ntf-next'" mode="out-in">
          <div :key="active.id" class="flex items-start gap-3 px-4 pb-3.5 pt-[18px]">
            <span
              class="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg"
              :class="[visual.tint, visual.color]"
            >
              <Icon :name="visual.icon" :size="15" :stroke-width="2" />
            </span>

            <div class="min-w-0 flex-1">
              <p class="truncate text-[14px] font-medium leading-7 text-ink">
                {{ active.title }}
              </p>
              <p
                v-if="active.body"
                class="ntf-body mt-1.5 max-h-[38vh] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-ink-2"
              >
                {{ active.body }}
              </p>
            </div>

            <button
              class="ntf-icon-btn -mr-1 -mt-1"
              :title="t('notifications.close')"
              :aria-label="t('notifications.close')"
              @click="closeCurrent"
            >
              <Icon name="x" :size="15" />
            </button>
          </div>
        </Transition>

        <!-- 底部：级别 + 时间；多条时提供切换与全部关闭 -->
        <footer class="flex items-center gap-2 border-t border-edge/60 px-4 py-2.5">
          <span class="text-[11.5px]" :class="visual.color">
            {{ t(`notifications.level.${active.level}`) }}
          </span>
          <span class="text-[11.5px] text-ink-3">·</span>
          <span class="tabular-nums text-[11.5px] text-ink-3">{{ timeText }}</span>
          <span class="flex-1" />

          <template v-if="total > 1">
            <button
              class="ntf-icon-btn !h-6 !w-6"
              :title="t('notifications.prev')"
              :aria-label="t('notifications.prev')"
              @click="step(-1)"
            >
              <Icon name="chevron-left" :size="14" />
            </button>
            <span class="tabular-nums text-[11.5px] text-ink-3">
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
        </footer>
      </section>
    </Transition>
  </div>
</template>
