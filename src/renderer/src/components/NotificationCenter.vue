<script setup lang="ts">
// ─── 全局通知带（编辑区上方一整幅）─────────────────────────────────────────
// 设计要点（本轮口径）：
//  - **没有通知时整块不存在** —— `v-if` 在 Transition 内层，编辑区上方不会常驻一条空带；
//  - 有通知时是**与编辑区同宽的整幅带**（不是浮层卡片、不是圆角盒子）：中性淡底 +
//    底部 1px 分界 + 顶部内高光，强调来自**明度差**而不是色相（与主题文件头的
//    「副色用中性灰」一致）；
//  - 不再展示级别：图标与级别名一并取消（用户口径），只保留标题 / 说明 / 操作 / 关闭；
//  - 一屏只显示一条通知（最新的），多条时用 ‹ n/m › 切换、可逐条或整体关闭；
//  - 不自动消失：只有用户点 X / 全部关闭才收起，内容与顺序由 SQLite 持久化；
//  - 组件只读 store、只调 store 动作，不直接接触 IPC 或数据库。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotificationsStore } from '../stores/notifications'
import Icon from './Icon.vue'

const { t, locale } = useI18n()
const notifications = useNotificationsStore()

const active = computed(() => notifications.active)
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
  <!-- 通知带：**没有通知时整块不存在**（`v-if` 在 Transition 内层）——
       所以空态下编辑区上方不会多出一条空带，也不会把正文挤下去。
       有通知时是整幅铺开的一条带，进出场把**高度、透明度、位移**一起动
       （见 overlays.css 的 `.ntf-reveal-*`），于是「带子挤开正文」本身就是动画。 -->
  <Transition name="ntf-reveal">
    <div v-if="active" class="ntf-reveal">
      <div class="ntf-strip" data-notification-center>
        <div class="ntf-item" data-ntf-item>
          <!-- 内容切换：上一条自左、下一条自右（配合 ‹ › 的语义） -->
          <Transition :name="dir === 'prev' ? 'ntf-prev' : 'ntf-next'" mode="out-in">
            <div :key="active.id" class="ntf-row">
              <div class="ntf-content">
                <p class="ntf-title">{{ active.title }}</p>
                <p v-if="active.body" class="ntf-body">{{ active.body }}</p>
              </div>

              <!-- 操作按钮（可交互通知，如「创建并打开 / 取消」）：点击即收起本条，
                   再按 payload.kind 派发给注册的处理器。
                   ⚠️ 位置在本轮改过：原来挂在**标题/正文下面（左侧）**，用户口径是「操作按钮放在右边」——
                   现在它是行内独立一列，排在正文与右侧信息条之间，与标题首行同一条基线。 -->
              <div v-if="active.actions.length" class="ntf-actions">
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

              <!-- 右侧信息条：时间 · （多条时的步进与全部关闭）· 关闭本条；
                   整条与标题首行同高（.ntf-meta 的 height 就是标题行高） -->
              <div class="ntf-meta" data-ntf-meta>
                <span class="ntf-time tabular-nums">{{ timeText }}</span>

                <template v-if="total > 1">
                  <span class="ntf-sep" />
                  <span class="ntf-steps">
                    <button
                      class="ntf-icon-btn ntf-icon-btn--sm"
                      :title="t('notifications.prev')"
                      :aria-label="t('notifications.prev')"
                      @click="step(-1)"
                    >
                      <Icon name="chevron-left" :size="14" />
                    </button>
                    <span class="ntf-count tabular-nums" data-ntf-count>
                      {{ notifications.activeIndex + 1 }}/{{ total }}
                    </span>
                    <button
                      class="ntf-icon-btn ntf-icon-btn--sm"
                      :title="t('notifications.next')"
                      :aria-label="t('notifications.next')"
                      @click="step(1)"
                    >
                      <Icon name="chevron-right" :size="14" />
                    </button>
                  </span>
                  <button
                    class="ntf-text-btn"
                    :title="t('notifications.closeAll')"
                    @click="notifications.closeAll()"
                  >
                    {{ t('notifications.closeAll') }}
                  </button>
                </template>

                <span class="ntf-sep" />
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
        </div>
      </div>
    </div>
  </Transition>
</template>
