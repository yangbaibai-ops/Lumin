<script setup lang="ts">
// ─── 设置 · 快捷键 ──────────────────────────────────────────────────────────
// 数据来源是命令注册表的解析结果（lib/keymap/service.ts）：默认键 + 用户覆盖。
// 交互：搜索 / 按分组浏览 / 点「修改」进入录制 / 单条恢复默认 / 清除绑定 / 全部恢复默认。
// 录制期间通过 setKeymapRecording(true) 让全局快捷键服务整体让行，避免「录 Ctrl+N 时真的新建了文档」。
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { currentKeymap, setKeymapRecording, type ResolvedCommand } from '../lib/keymap/service'
import { eventToSpec, parseKeybinding, specToChips } from '../lib/keymap/keys'
import { filterCommandsByKey, isConflictingKey, keyQueryFromEvent } from '../lib/keymap/keySearch'
import {
  auditKeybindings,
  validateKeybinding,
  type KeymapValidationResult
} from '../lib/keymap/validate'
import Icon from './Icon.vue'

const { t } = useI18n()
const settings = useSettingsStore()

/** 正在录制的命令 id（null = 未录制） */
const recordingId = ref<string | null>(null)
const filter = ref('')
/**
 * 「按键搜索」条件：在搜索框里按下组合键后置为规范表达式（如 `Ctrl+Alt+T`）。
 * 非空时列表只按这个键筛（文字条件暂时让位）；退格 / 小 × / Esc 清除。
 */
const keyQuery = ref<string | null>(null)
/** 最近一次录制被拒绝的原因（与行 id 绑定；重新录制或恢复默认时清掉） */
const recordError = ref<{ id: string; result: KeymapValidationResult } | null>(null)

/**
 * 解析结果（**唯一**的显示数据源）：默认键 + 用户覆盖，由命令注册表算出来。
 *
 * 依赖不是这里手写的：`resolved()` → `resolveCommands()` → `resolveKeys()` 会逐个命令读
 * `settings.keybindings`（ownKeys + 逐键 GET），所以改绑 / 解绑 / 恢复默认都会让这里重算。
 * 下面那次 `void settings.keybindings` 只是"服务换了实现也别把依赖丢了"的兜底 ——
 * **不要再往本组件里搬第二份键位表**（改绑后显示不更新正是这么来的，见 service.ts 的长注释）。
 */
const commands = computed<ResolvedCommand[]>(() => {
  void settings.keybindings
  return currentKeymap()?.resolved() ?? []
})

const titleOf = (c: ResolvedCommand): string => t(c.titleKey)

const filtered = computed(() => {
  // 按键条件优先：按下的键直接决定列表（文字搜索暂时不参与）；
  // 清除按键胶囊后自动回到原来的文字搜索。
  if (keyQuery.value) return filterCommandsByKey(commands.value, keyQuery.value)
  const q = filter.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter((c) => {
    const keys = (c.keys ?? '').toLowerCase()
    return (
      titleOf(c).toLowerCase().includes(q) || keys.includes(q) || c.id.toLowerCase().includes(q)
    )
  })
})

/** 按键筛选命中 0 条 = 这个组合键没有绑定任何命令（要明确告诉用户，而不是空白列表） */
const keyQueryUnbound = computed(() => !!keyQuery.value && filtered.value.length === 0)

/** 按键筛选结果里存在冲突（同一组合键被多条命令占用） */
const keyQueryConflicting = computed(() => !!keyQuery.value && isConflictingKey(filtered.value))

/**
 * 搜索框内按下组合键 → 记录成按键筛选条件。
 *
 * 关键点：
 *   * 必须 `preventDefault`：否则 Ctrl+Shift+P 会打开命令面板之类（入口由全局分发器让行，
 *     见 `data-keymap-capture` 与 service.ts）；
 *   * 裸字母/退格不拦 —— 用户还要正常输入文字；
 *   * 退格 / Delete / Esc 清除按键条件（有按键条件时优先清它，不关设置页）。
 */
function onSearchKeydown(e: KeyboardEvent): void {
  if (keyQuery.value && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault()
    e.stopPropagation()
    clearKeyQuery()
    return
  }
  if (keyQuery.value && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    clearKeyQuery()
    return
  }
  const spec = keyQueryFromEvent(e)
  if (!spec) return
  e.preventDefault()
  e.stopPropagation()
  keyQuery.value = spec
}

/** 清除按键条件（回到文字搜索） */
function clearKeyQuery(): void {
  keyQuery.value = null
}

/** 清除全部搜索条件（文字 + 按键） */
function clearAllSearch(): void {
  filter.value = ''
  keyQuery.value = null
}

/** 按分组聚合（保持命令表里的出现顺序，分组名走 i18n） */
const groups = computed(() => {
  const out: { key: string; label: string; items: ResolvedCommand[] }[] = []
  for (const cmd of filtered.value) {
    let g = out.find((x) => x.key === cmd.groupKey)
    if (!g) {
      g = { key: cmd.groupKey, label: t(cmd.groupKey), items: [] }
      out.push(g)
    }
    g.items.push(cmd)
  }
  return out
})

const customizedCount = computed(() => commands.value.filter((c) => c.customized).length)

/**
 * 历史数据审计（**只读**）：已存在的非法绑定（如 `f`）标成「无效」，
 * 不静默删除 —— 用户点「恢复默认」才真正改设置。默认键不查保留表（见 validate.ts）。
 */
const issues = computed(() =>
  auditKeybindings(
    commands.value.map((c) => ({
      id: c.id,
      keys: c.keys,
      customized: c.customized,
      titleKey: c.titleKey
    }))
  )
)

function issueOf(c: ResolvedCommand): KeymapValidationResult | undefined {
  return issues.value[c.id]
}

/** 冲突命令 id → 标题 */
function namesOf(result: KeymapValidationResult): string {
  return result.conflictWith
    .map((id) => commands.value.find((x) => x.id === id))
    .filter((x): x is ResolvedCommand => !!x)
    .map((x) => titleOf(x))
    .join(' / ')
}

/** 把校验结果落成一句可见文案（含"建议改为 …"） */
function resultText(result: KeymapValidationResult): string {
  const base = t(result.messageKey, { names: namesOf(result) })
  if (result.suggestion) return `${base} ${t('keymap.suggest', { key: result.suggestion })}`
  return base
}

function errorTextOf(c: ResolvedCommand): string {
  if (recordError.value?.id === c.id) return resultText(recordError.value.result)
  const issue = issueOf(c)
  if (!issue) return ''
  return t('keymap.invalidHint', { reason: resultText(issue) })
}

function errorIdOf(c: ResolvedCommand): string {
  return `keymap-error-${c.id}`
}

function startRecording(id: string): void {
  recordError.value = null
  recordingId.value = id
  setKeymapRecording(true)
  window.addEventListener('keydown', onRecordKey, true)
}

function stopRecording(): void {
  recordingId.value = null
  setKeymapRecording(false)
  window.removeEventListener('keydown', onRecordKey, true)
}

/** 录制：Esc 取消、Backspace/Delete 解绑、其余合法组合写入 */
function onRecordKey(e: KeyboardEvent): void {
  const id = recordingId.value
  if (!id) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    stopRecording()
    return
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    settings.setKeybinding(id, null)
    recordError.value = null
    stopRecording()
    return
  }
  const spec = eventToSpec(e)
  if (!spec) return // 只按了修饰键：继续等主键
  /**
   * 统一校验（纯函数在 lib/keymap/validate.ts）：拒绝时**不写 settings**，
   * 保留原绑定并在行内显示红字 + aria-invalid。`spec` 用的是校验后的规范化写法。
   */
  const result = validateKeybinding(spec, {
    selfId: id,
    bindings: commands.value.map((c) => ({ id: c.id, keys: c.keys, titleKey: c.titleKey }))
  })
  if (!result.ok) {
    recordError.value = { id, result }
    stopRecording()
    return
  }
  settings.setKeybinding(id, result.spec)
  recordError.value = null
  stopRecording()
}

function resetOne(id: string): void {
  recordError.value = null
  settings.resetKeybinding(id)
}

function resetAll(): void {
  recordError.value = null
  settings.resetAllKeybindings()
}

onBeforeUnmount(() => {
  if (recordingId.value) stopRecording()
})

/** 冲突提示里的其他命令名 */
function conflictNames(c: ResolvedCommand): string {
  return c.conflictWith
    .map((id) => commands.value.find((x) => x.id === id))
    .filter(Boolean)
    .map((x) => titleOf(x as ResolvedCommand))
    .join(' / ')
}

/** 表达式至少能被解析（历史数据可能更糟：手写坏格式） */
function parseOk(c: ResolvedCommand): boolean {
  return !!c.keys && parseKeybinding(c.keys) !== null
}
</script>

<template>
  <div>
    <section class="surface mb-4 p-5">
      <div class="mb-3 flex items-start gap-3">
        <span
          class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent"
        >
          <Icon name="keyboard" :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="text-[13.5px] text-ink">{{ t('keymap.title') }}</h3>
          <p class="mt-1 text-ui-sm leading-relaxed text-ink-2b">{{ t('keymap.desc') }}</p>
        </div>
        <button
          class="btn btn-outline flex-none px-3 py-1.5 text-ui"
          :disabled="customizedCount === 0"
          :title="t('keymap.resetAll')"
          @click="resetAll"
        >
          <Icon name="refresh" :size="13" />
          {{ t('keymap.resetAll') }}
        </button>
      </div>

      <div
        class="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 py-1.5 transition-colors focus-within:border-accent"
      >
        <Icon name="search" :size="13" class="flex-none text-ink-3" />
        <input
          v-model="filter"
          data-keymap-capture
          class="keymap-search min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-2b"
          :placeholder="t('keymap.searchPlaceholder')"
          :aria-label="t('keymap.searchPlaceholder')"
          @keydown="onSearchKeydown"
        />
        <!-- 按下的组合键：胶囊 + 一键清除（退格 / Esc 同样可清） -->
        <span
          v-if="keyQuery"
          class="key-query flex flex-none items-center gap-1"
          data-keymap-key-query
        >
          <span class="text-[11.5px] text-ink-2b">{{ t('keymap.keyFilterLabel') }}</span>
          <kbd v-for="k in specToChips(keyQuery)" :key="k" class="key-chip">{{ k }}</kbd>
          <button
            type="button"
            class="ml-0.5 flex-none text-ink-2b hover:text-ink"
            :title="t('keymap.clearKeyFilter')"
            :aria-label="t('keymap.clearKeyFilter')"
            data-keymap-key-query-clear
            @click="clearKeyQuery"
          >
            <Icon name="x" :size="12" />
          </button>
        </span>
        <button
          v-if="filter || keyQuery"
          class="flex-none text-ink-2b hover:text-ink"
          :title="t('keymap.clearSearch')"
          :aria-label="t('keymap.clearSearch')"
          data-keymap-search-clear
          @click="clearAllSearch"
        >
          <Icon name="x" :size="12" />
        </button>
        <span class="flex-none text-[11.5px] text-ink-2b">
          {{ t('keymap.customizedCount', { n: customizedCount }) }}
        </span>
      </div>
      <p v-if="keyQueryUnbound" class="mt-2 text-ui-sm text-ink-2b" data-keymap-key-unbound>
        {{ t('keymap.keyFilterUnbound', { keys: keyQuery }) }}
      </p>
      <p
        v-else-if="keyQueryConflicting"
        class="mt-2 text-ui-sm text-warning-ink"
        data-keymap-key-conflict
      >
        {{ t('keymap.keyFilterConflict', { keys: keyQuery }) }}
      </p>
    </section>

    <section v-for="g in groups" :key="g.key" class="surface mb-4 p-5">
      <h3 class="mb-3 text-[13.5px] text-ink">{{ g.label }}</h3>
      <div class="flex flex-col gap-1">
        <div
          v-for="c in g.items"
          :key="c.id"
          class="key-row flex flex-wrap items-center gap-3 rounded-lg px-2 py-1.5"
          :class="{ 'key-row--hit': keyQuery === c.keys }"
          :data-command="c.id"
          :data-keymap-invalid="issueOf(c) ? 'true' : undefined"
        >
          <span class="min-w-0 flex-1 truncate text-[13px] text-ink">{{ titleOf(c) }}</span>

          <!-- 历史非法绑定（如 `f`）：红色「无效」徽标 + 恢复默认，不静默删除 -->
          <span
            v-if="issueOf(c)"
            class="flex flex-none items-center gap-1 text-ui-sm text-danger-ink"
            :title="errorTextOf(c)"
            data-keymap-invalid-badge
          >
            <Icon name="alert-triangle" :size="12" />
            {{ t('keymap.invalidBadge') }}
          </span>
          <!-- 冲突：同一个键被多条命令占用 -->
          <span
            v-else-if="c.conflictWith.length"
            class="flex flex-none items-center gap-1 text-[11.5px] text-warning-ink"
            :title="t('keymap.conflictWith', { names: conflictNames(c) })"
          >
            <Icon name="alert-triangle" :size="12" />
            {{ t('keymap.conflict') }}
          </span>
          <span v-else-if="c.customized" class="flex-none text-[11.5px] text-accent-ink">{{
            t('keymap.customized')
          }}</span>

          <!-- 当前键位 -->
          <span class="flex flex-none items-center gap-1">
            <template v-if="recordingId === c.id">
              <span
                class="key-recording rounded-md border border-accent px-2 py-0.5 text-[11.5px] text-accent-ink"
              >
                {{ t('keymap.pressKeys') }}
              </span>
            </template>
            <template v-else-if="parseOk(c)">
              <kbd v-for="k in specToChips(c.keys)" :key="k" class="key-chip">{{ k }}</kbd>
            </template>
            <span v-else-if="c.keys" class="text-ui-sm text-danger-ink">{{ c.keys }}</span>
            <span v-else class="text-[11.5px] text-ink-2b">{{ t('keymap.unbound') }}</span>
          </span>

          <span class="flex flex-none items-center gap-1">
            <button
              class="icon-btn h-6 w-6"
              :class="{ 'key-invalid': !!issueOf(c) || recordError?.id === c.id }"
              :title="t('keymap.edit')"
              :aria-label="t('keymap.edit')"
              :aria-invalid="issueOf(c) || recordError?.id === c.id ? 'true' : undefined"
              :aria-describedby="issueOf(c) || recordError?.id === c.id ? errorIdOf(c) : undefined"
              @click="recordingId === c.id ? stopRecording() : startRecording(c.id)"
            >
              <Icon :name="recordingId === c.id ? 'x' : 'keyboard'" :size="12" />
            </button>
            <button
              class="icon-btn h-6 w-6"
              :class="{ 'opacity-40': !c.customized }"
              :disabled="!c.customized"
              :title="t('keymap.resetOne')"
              :aria-label="t('keymap.resetOne')"
              @click="resetOne(c.id)"
            >
              <Icon name="refresh" :size="12" />
            </button>
          </span>

          <!-- 可见错误（红字 + role=alert）：录制被拒绝或历史非法绑定都会落到这里。
               `aria-describedby` 指的就是这个节点，读屏器与截图看到的是同一句文案。 -->
          <p
            v-if="errorTextOf(c)"
            :id="errorIdOf(c)"
            class="w-full text-ui-sm leading-relaxed text-danger-ink"
            role="alert"
            :data-keymap-error="recordError?.id === c.id ? 'record' : 'invalid'"
          >
            {{ errorTextOf(c) }}
            <template v-if="issueOf(c)">— {{ t('keymap.invalidShort') }}</template>
          </p>
        </div>
        <p v-if="!g.items.length" class="px-2 py-3 text-ui-sm text-ink-2b">
          {{ t('keymap.noMatch') }}
        </p>
      </div>
    </section>

    <p class="px-1 text-[11.5px] leading-relaxed text-ink-2b">{{ t('keymap.hint') }}</p>
  </div>
</template>

<style scoped>
.key-row:hover {
  background: var(--panel-2);
}
/* 「按键搜索」命中的行：给一层浅强调底色，配合上面的筛选结果做视觉锚点 */
.key-row--hit {
  background: var(--accent-soft);
}
.key-row--hit:hover {
  background: var(--accent-soft);
}
.key-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  padding: 2px 6px;
  border: 1px solid var(--edge-strong);
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 11.5px;
  font-family: var(--font-sans);
  color: var(--ink-2);
}
.key-recording {
  animation: keymap-pulse 1.1s ease-in-out infinite;
}
@keyframes keymap-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .key-recording {
    animation: none;
  }
}
</style>
