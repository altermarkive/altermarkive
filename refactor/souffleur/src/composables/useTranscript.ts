/**
 * composables/useTranscript.ts
 *
 * One line per utterance, newest last.
 * Transcript is held in memory and offered as a download.
 */

import { computed, ref } from 'vue'

export function useTranscript () {
  const lines = ref<string[]>([])

  const text = computed(() => lines.value.join('\n'))

  function addLine (line: string) {
    lines.value.push(line)
  }

  function clear () {
    lines.value = []
  }

  function download () {
    const blob = new Blob([`${text.value}\n`], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'transcript.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return { lines, text, addLine, clear, download }
}
