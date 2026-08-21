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

  const { interim, lines } = defineProps<{
    lines: string[]
    interim: string
  }>()

  const emit = defineEmits<{ download: [] }>()

  const body = computed(() => {
    const settled = lines.join('\n')
    if (!interim) {
      return settled || 'No speech yet.'
    }
    return settled ? `${settled}\n${interim}` : interim
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
