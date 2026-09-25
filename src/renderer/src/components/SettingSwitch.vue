<script setup lang="ts">
/**
 * ─── 唯一实现的开/关开关 ────────────────────────────────────────────────────────
 *
 * 为什么抽成组件（审计 §8）：设置页里同一个 `.switch` 有**十份手写副本**，而其中七份
 * 连 `role="switch"` / `aria-checked` 都没写 —— 读屏器只会念「按钮」，不会念开还是关；
 * 另有一处（代码块行号）甚至用 `<span class="switch">` 冒充按钮（span 不可聚焦，
 * 键盘用户根本按不到）。样式相同、语义各异，正是"每个调用点各写一遍"的典型后果。
 *
 * 语义与键盘都由本组件负责，调用方只管"值 + 点击"：
 *   * `role="switch"` + `aria-checked` —— 读屏器播报「开关，已打开/已关闭」；
 *   * 真 `<button>` —— 可聚焦、空格/回车原生可触发；
 *   * `aria-label` 必填 —— 视觉标签在兄弟节点里（`.set-row-label`），读屏器读不到关联关系，
 *     必须显式给可访问名。
 */
const props = withDefaults(
  defineProps<{
    /** 当前状态 */
    modelValue: boolean
    /** 可访问名（必填：视觉标签在兄弟节点里，读屏器不会自动关联） */
    label: string
    /** 点不动时（如父级联动关闭） */
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

/** 只发"新值"，不自己改状态 —— 状态永远由父级（设置 store）持有 */
function toggle(): void {
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch"
    :class="{ on: modelValue }"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="label"
    :disabled="disabled"
    data-switch
    @click="toggle"
  />
</template>
