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

// Gap after a healthy session ends of its own accord - the browser caps session
// length even mid-utterance, and the microphone is not captured until the next
// instance starts, so this is audio the transcript loses. Short enough to cost a
// fraction of a word, long enough to yield the browser a turn to release the mic.
const HEALTHY_RESTART_DELAY_MS = 100

// Ceiling for the backoff. A recogniser that keeps failing - no microphone, or
// no network, which iOS speech recognition needs - would otherwise restart as
// fast as the browser tears it down, several times a second.
const MAX_RESTART_DELAY_MS = 10_000

const LANGUAGE = 'en-US'

type Constructor = new () => SpeechRecognition

function constructor (): Constructor | undefined {
  return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition
}

// Plain Chromium ships without Google's API keys, so `SpeechRecognition` exists
// and the microphone opens, but the speech service is never reachable: every
// attempt ends `audiostart` -> `audioend` -> `error: network`, with no result.
//
// Branded Chromium derivatives (Chrome, Edge, Brave, Opera) each advertise their
// own vendor brand alongside "Chromium"; a bare build advertises only "Chromium"
// plus the GREASE placeholder. Browsers without Client Hints - Safari, Firefox -
// report no brands at all and are not Chromium.
function isPlainChromium (): boolean {
  const brands = navigator.userAgentData?.brands
  if (!brands) {
    return false
  }
  const vendors = brands.filter(
    ({ brand }) => brand !== 'Chromium' && !/not.*brand/i.test(brand),
  )
  return brands.some(({ brand }) => brand === 'Chromium') && vendors.length === 0
}

// Why live transcription cannot run here, or '' when it can.
export function recognitionUnavailable (): string {
  if (!constructor()) {
    return 'This browser has no Web Speech API, so live transcription will not run.'
  }
  if (isPlainChromium()) {
    return 'This is plain Chromium, which cannot reach the speech service, '
      + 'so live transcription will not run. Use Google Chrome or Safari.'
  }
  return ''
}

export function useRecognition (onLine: (text: string) => void) {
  const listening = ref(false)
  const error = ref('')
  let interim = ''

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
      interim = pending.trim()
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
      if (interim) {
        onLine(interim)
      }
      interim = ''
      clearWatchdog()
      if (!active) {
        listening.value = false
        return
      }
      scheduleRestart()
    })

    return instance
  }

  function scheduleRestart () {
    if (restart !== undefined) {
      clearTimeout(restart)
    }
    const delay = failures === 0
      ? HEALTHY_RESTART_DELAY_MS
      : Math.min(RESTART_DELAY_MS * 2 ** failures, MAX_RESTART_DELAY_MS)
    restart = setTimeout(() => {
      restart = undefined
      if (active) {
        launch()
      }
    }, delay)
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
      listening.value = false
      failures += 1
      scheduleRestart()
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
  }

  return { listening, error, start, stop }
}
