/**
 * composables/useTranscript.ts
 *
 * The transcript with one line per utterance, newest last.
 * Held in memory, editable in place, and offered as a download.
 */

import { computed, ref } from 'vue'

export function useTranscript () {
  const text = ref('')

  const isEmpty = computed(() => text.value.trim().length === 0)

  function addLine (line: string) {
    text.value = text.value ? `${text.value}\n${line}` : line
  }

  function setText (replacement: string) {
    text.value = replacement
  }

  function clear () {
    text.value = ''
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

  return { text, isEmpty, addLine, setText, clear, download }
}
