/**
 * composables/useUniversalRecognition.ts
 *
 * Live transcription that runs entirely in the page: the microphone is captured
 * with `getUserMedia`, split into utterances by the energy VAD, and each
 * utterance is transcribed by Whisper through Transformers.js.
 *
 * This exists because the Web Speech path in `useRecognition.ts` needs a speech
 * service the browser may not be able to reach - plain Chromium ships without
 * the keys for it, and Firefox has no Web Speech API at all. Nothing here
 * leaves the device, so the only thing it needs is a microphone.
 *
 * What it costs: the model is downloaded on first use (cached afterwards), and
 * a line appears when its utterance ends rather than while it is being spoken,
 * so this path is later than Web Speech by roughly one pause plus one decode.
 */

import { ref, shallowRef } from 'vue'
import { openMicrophone } from '@/lib/micStream'
import { FrameSplitter, VadAccumulator } from '@/lib/vad'
import {
  loadTranscriber,
  type Progress,
  type Transcriber,
  transcriptionText,
  type WhisperChoice,
} from '@/lib/whisper'

/**
 * One step down from the file path's pair, because segments arrive continuously
 * here and decoding has to keep ahead of speech rather than merely finish.
 *
 * Both devices get `base.en`. The single-threaded WASM fallback is the one to
 * watch: base's encoder is ~90 GFLOP per 30 s window, comfortably under real
 * time on a current iPad, but if the queue starts shedding segments (see
 * `MAX_PENDING`) then `tiny.en` is the lever, at a real cost in accuracy.
 */
const MODELS: WhisperChoice = {
  webgpu: 'onnx-community/whisper-base.en',
  wasm: 'onnx-community/whisper-base.en',
}

/**
 * Segments waiting to be decoded. Reaching this means transcription is running
 * slower than speech, and the backlog would grow without bound - better to lose
 * the oldest utterance than to fall further behind on every one after it.
 */
const MAX_PENDING = 4

export function useUniversalRecognition (onLine: (text: string) => void) {
  const listening = ref(false)
  const error = ref('')
  const progress = ref<Progress>({ ratio: -1, detail: '' })

  const transcriber = shallowRef<Transcriber>()
  let microphone: Awaited<ReturnType<typeof openMicrophone>> | undefined
  let active = false

  const vad = new VadAccumulator()
  const splitter = new FrameSplitter(vad.frameSamples)
  const pending: Float32Array[] = []
  let draining: Promise<void> | undefined
  let dropped = 0

  function enqueue (segment: Float32Array) {
    pending.push(segment)
    if (pending.length > MAX_PENDING) {
      pending.shift()
      dropped += 1
      error.value = `Transcription is behind; dropped ${dropped} segment(s).`
    }
    draining ??= drain().finally(() => {
      draining = undefined
    })
  }

  /**
   * One decode at a time: the pipeline is not reentrant, and overlapping calls
   * would only make every utterance slower.
   */
  async function drain () {
    while (pending.length > 0) {
      const segment = pending.shift()!
      const instance = transcriber.value
      if (!instance) {
        continue
      }
      try {
        // No `chunk_length_s`: the VAD already capped the segment below the
        // 30 s window, so the chunking machinery would add cost and nothing else.
        const text = transcriptionText(
          await instance.pipeline(segment, { return_timestamps: false }),
        )
        if (text) {
          onLine(text)
        }
      } catch (error_) {
        error.value = `Transcription failed: ${message(error_)}`
      }
    }
  }

  async function start () {
    if (active) {
      return
    }
    active = true
    error.value = ''
    dropped = 0

    try {
      progress.value = { ratio: -1, detail: 'Loading speech model...' }
      transcriber.value ??= await loadTranscriber(MODELS, update => {
        progress.value = update
      })
      if (!active) {
        return
      }

      progress.value = {
        ratio: -1,
        detail: `Listening on ${transcriber.value.webgpu ? 'GPU' : 'CPU'}.`,
      }
      microphone = await openMicrophone(block => {
        splitter.split(block, frame => {
          const segment = vad.feed(frame)
          if (segment) {
            enqueue(segment)
          }
        })
      })
      if (!active) {
        // Stopped while the permission prompt was up.
        await microphone.stop()
        microphone = undefined
        return
      }
      listening.value = true
    } catch (error_) {
      active = false
      listening.value = false
      error.value = `Recording unavailable due to ${message(error_)}`
    }
  }

  async function stop () {
    if (!active) {
      return
    }
    active = false
    listening.value = false

    await microphone?.stop()
    microphone = undefined

    // Whatever was still being spoken when the button was pressed: no boundary
    // will arrive for it, so it has to be forced out.
    const tail = vad.flush()
    splitter.reset()
    if (tail) {
      enqueue(tail)
    }
    await draining
  }

  return { listening, error, progress, start, stop }
}

function message (error_: unknown): string {
  return error_ instanceof Error ? error_.message : String(error_)
}
