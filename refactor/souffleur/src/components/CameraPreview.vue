<template>
  <video
    ref="element"
    class="preview"
    muted
    playsinline
  />
</template>

<script lang="ts" setup>
  import { useTemplateRef, watchEffect } from 'vue'

  const video = defineModel<HTMLVideoElement | undefined>('video')

  const element = useTemplateRef<HTMLVideoElement>('element')

  watchEffect(() => {
    video.value = element.value ?? undefined
  })
</script>

<style scoped>
.preview {
  flex: 0 0 auto;
  width: 64px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  background: rgb(from currentcolor r g b / 0.12);
}
</style>
