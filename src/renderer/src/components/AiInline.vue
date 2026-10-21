<script setup lang="ts">
// 行内 Markdown → 纯 Vue 文本节点（**不拼 HTML**，模型输出不可信）。
// 支持 `code` / **strong** / *em* / ~~del~~；未闭合的标记按普通文本处理。
import { computed } from 'vue'
import { parseAiInline } from '../lib/aiMarkdown'

const props = defineProps<{ text: string }>()
const tokens = computed(() => parseAiInline(props.text))
</script>

<template>
  <template v-for="(tok, i) in tokens" :key="i">
    <code v-if="tok.kind === 'code'" class="ai-md-code">{{ tok.text }}</code>
    <strong v-else-if="tok.kind === 'strong'" class="ai-md-strong">{{ tok.text }}</strong>
    <em v-else-if="tok.kind === 'em'" class="ai-md-em">{{ tok.text }}</em>
    <del v-else-if="tok.kind === 'del'" class="ai-md-del">{{ tok.text }}</del>
    <template v-else>{{ tok.text }}</template>
  </template>
</template>
