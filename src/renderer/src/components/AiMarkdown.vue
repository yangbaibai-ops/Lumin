<script setup lang="ts">
// ─── AI 回答的 Markdown 渲染（无 HTML 注入面）────────────────────────────────────
//
// 段落 / 列表 / 代码块 / 行内代码是需求点；公式 `$…$` 按纯文本显示（不解释）。
// 解析在 `lib/aiMarkdown.ts`（纯函数、单测覆盖），这里只负责把块映射成元素。
import { computed } from 'vue'
import { parseAiMarkdown } from '../lib/aiMarkdown'
import AiInline from './AiInline.vue'

const props = defineProps<{ source: string }>()
const blocks = computed(() => parseAiMarkdown(props.source))
</script>

<template>
  <div class="ai-md" data-ai-markdown>
    <template v-for="(block, i) in blocks" :key="i">
      <h1 v-if="block.type === 'heading' && block.level === 1" class="ai-md-h ai-md-h1">
        <AiInline :text="block.content" />
      </h1>
      <h2 v-else-if="block.type === 'heading' && block.level === 2" class="ai-md-h ai-md-h2">
        <AiInline :text="block.content" />
      </h2>
      <h3 v-else-if="block.type === 'heading' && block.level === 3" class="ai-md-h ai-md-h3">
        <AiInline :text="block.content" />
      </h3>
      <h4 v-else-if="block.type === 'heading' && block.level === 4" class="ai-md-h ai-md-h4">
        <AiInline :text="block.content" />
      </h4>
      <h5 v-else-if="block.type === 'heading' && block.level === 5" class="ai-md-h ai-md-h5">
        <AiInline :text="block.content" />
      </h5>
      <h6 v-else-if="block.type === 'heading' && block.level === 6" class="ai-md-h ai-md-h6">
        <AiInline :text="block.content" />
      </h6>

      <pre v-else-if="block.type === 'code'" class="ai-md-pre"><code>{{ block.code }}</code></pre>

      <ul v-else-if="block.type === 'list' && !block.ordered" class="ai-md-list">
        <li v-for="(item, j) in block.items" :key="j"><AiInline :text="item" /></li>
      </ul>
      <ol v-else-if="block.type === 'list' && block.ordered" class="ai-md-list">
        <li v-for="(item, j) in block.items" :key="j"><AiInline :text="item" /></li>
      </ol>

      <blockquote v-else-if="block.type === 'quote'" class="ai-md-quote">
        <AiInline :text="block.content" />
      </blockquote>

      <hr v-else-if="block.type === 'hr'" class="ai-md-hr" />

      <p v-else-if="block.type === 'paragraph'" class="ai-md-p">
        <AiInline :text="block.content" />
      </p>
    </template>
  </div>
</template>
