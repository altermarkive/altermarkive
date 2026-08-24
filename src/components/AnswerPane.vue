<template>
  <pre class="pane">{{ body }}</pre>
</template>

<script lang="ts" setup>
  import type { Answer } from '@/lib/solver'
  import { computed } from 'vue'

  const { answer, status } = defineProps<{
    answer: Answer | undefined
    status: string
  }>()

  const body = computed(() => {
    if (!answer) {
      return status
    }
    return answer.question ? `${answer.question}\n\n${answer.text}` : answer.text
  })
</script>

<style scoped>
.pane {
  white-space: pre-wrap;
  font-size: 9pt;
  margin: 0;
  height: 100%;
  overflow-y: auto;
}
</style>
