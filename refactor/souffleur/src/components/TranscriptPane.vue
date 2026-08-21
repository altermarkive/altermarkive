<template>
  <div class="flex flex-col h-full gap-3">
    <div>
      <v-btn
        :disabled="lines.length === 0"
        prepend-icon="mdi-download"
        size="small"
        text="Download transcript"
        variant="tonal"
        @click="emit('download')"
      />
    </div>

    <pre class="pane">{{ body }}</pre>
  </div>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'

  const { error, interim, lines } = defineProps<{
    lines: string[]
    interim: string
    error: string
  }>()

  const emit = defineEmits<{ download: [] }>()

  const body = computed(() => {
    const settled = lines.join('\n')
    if (interim) {
      return settled ? `${settled}\n${interim}` : interim
    }
    if (settled) {
      return settled
    }
    // With nothing transcribed, a recogniser error is the useful thing to show:
    // otherwise a dead recogniser is indistinguishable from silence.
    return error || 'No speech yet.'
  })
</script>

<style scoped>
.pane {
  white-space: pre-wrap;
  font-size: 9pt;
  margin: 0;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
}
</style>
