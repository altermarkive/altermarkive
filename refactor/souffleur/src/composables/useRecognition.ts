/**
 * composables/useRecognition.ts
 *
 * Live transcription via the Web Speech API:
 * the recogniser owns the microphone and does its own endpointing, emitting one
 * final result per utterance - the same granularity the VAD segments would have produced.
 *
 * iOS Safari makes that harder than it sounds. `continuous` is unreliable, and
 * recognition routinely stops firing results without raising an error, so this
 * wrapper restarts on every `end` and keeps a watchdog for the silent-death case.
 */

import { ref, shallowRef } from 'vue'

// Recognition that has gone quiet this long is presumed dead and restarted.
const WATCHDOG_MS = 10_000

// Floor between restarts, so a hard failure cannot spin.
const RESTART_DELAY_MS = 400

// Ceiling for the backoff. A recogniser that keeps failing - no microphone, or
// no network, which iOS speech recognition needs - would otherwise restart as
// fast as the browser tears it down, several times a second.
const MAX_RESTART_DELAY_MS = 10_000

const LANGUAGE = 'en-US'

type Constructor = new () => SpeechRecognition

function constructor (): Constructor | undefined {
  return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition
}

export function isRecognitionSupported (): boolean {
  return constructor() !== undefined
}

export function useRecognition (onLine: (text: string) => void) {
  const listening = ref(false)
  const interim = ref('')
  const error = ref('')

  const recognition = shallowRef<SpeechRecognition>()
  let active = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let restart: ReturnType<typeof setTimeout> | undefined
  // Consecutive failures with no result in between; drives the backoff.
  let failures = 0

  function clearWatchdog () {
    if (watchdog !== undefined) {
      clearTimeout(watchdog)
      watchdog = undefined
    }
  }

  function armWatchdog () {
    clearWatchdog()
    watchdog = setTimeout(() => {
      // Silent death: no results for a while. Abort to provoke `end`, which
      // restarts us. `abort` rather than `stop` so nothing is left pending.
      recognition.value?.abort()
    }, WATCHDOG_MS)
  }

  function build (): SpeechRecognition | undefined {
    const Recognition = constructor()
    if (!Recognition) {
      error.value = 'Speech recognition unavailable in this browser'
      return undefined
    }

    const instance = new Recognition()
    instance.continuous = true
    instance.interimResults = true
    instance.lang = LANGUAGE

    instance.addEventListener('result', event => {
      armWatchdog()
      // Anything coming through means the recogniser is healthy again.
      failures = 0
      let pending = ''
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]
        const text = result[0].transcript.trim()
        if (!text) {
          continue
        }
        if (result.isFinal) {
          onLine(text)
        } else {
          pending += `${text} `
        }
      }
      interim.value = pending.trim()
    })

    instance.addEventListener('error', event => {
      // `no-speech` and `aborted` are routine on a quiet microphone; a denied
      // permission is not something a restart can fix.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        error.value = `Microphone unavailable due to ${event.error}`
        active = false
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        // `network` is transient on a phone, so back off rather than give up.
        failures += 1
        error.value = `Recognition error: ${event.error}`
      }
    })

    instance.addEventListener('end', () => {
      interim.value = ''
      clearWatchdog()
      if (!active) {
        listening.value = false
        return
      }
      const delay = Math.min(RESTART_DELAY_MS * 2 ** failures, MAX_RESTART_DELAY_MS)
      restart = setTimeout(() => {
        if (active) {
          launch()
        }
      }, delay)
    })

    return instance
  }

  function launch () {
    const instance = build()
    if (!instance) {
      active = false
      listening.value = false
      return
    }
    recognition.value = instance
    try {
      instance.start()
      listening.value = true
      armWatchdog()
    } catch {
      // `start` throws if the previous instance has not fully released the
      // microphone yet; the `end` handler will come back around.
      listening.value = false
    }
  }

  function start () {
    if (active) {
      return
    }
    active = true
    error.value = ''
    launch()
  }

  function stop () {
    active = false
    clearWatchdog()
    if (restart !== undefined) {
      clearTimeout(restart)
      restart = undefined
    }
    recognition.value?.stop()
    listening.value = false
    interim.value = ''
  }

  return { listening, interim, error, start, stop }
}
