<template>
  <div class="flex flex-col h-full gap-3">
    <div>
      <v-btn
        :disabled="isEmpty"
        prepend-icon="mdi-download"
        size="small"
        text="Download transcript"
        variant="tonal"
        @click="emit('download')"
      />
    </div>

    <textarea
      ref="area"
      v-model="text"
      class="pane"
      :placeholder="error || 'No speech yet.'"
      spellcheck="false"
    />
  </div>
</template>

<script lang="ts" setup>
  import { computed, nextTick, useTemplateRef, watch } from 'vue'

  const { error } = defineProps<{
    error: string
  }>()

  const text = defineModel<string>({ required: true })

  const emit = defineEmits<{ download: [] }>()

  const area = useTemplateRef<HTMLTextAreaElement>('area')

  const isEmpty = computed(() => text.value.trim().length === 0)

  // Recognition appends while the user may be typing; rewriting the textarea
  // value drops the caret to the end, so put it back where it was.
  watch(text, async () => {
    const element = area.value
    if (!element || document.activeElement !== element) {
      return
    }
    const { selectionStart, selectionEnd } = element
    await nextTick()
    element.setSelectionRange(selectionStart, selectionEnd)
  })
</script>

<style scoped>
.pane {
  font-family: inherit;
  font-size: 9pt;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  white-space: pre-wrap;
}
</style>
