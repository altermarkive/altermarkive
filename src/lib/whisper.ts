/**
 * lib/whisper.ts
 *
 * Loading Whisper through Transformers.js, shared by both local transcription
 * paths.
 *
 * The model weights come from the Hugging Face CDN at runtime, not from this
 * site, and Transformers.js caches them in the browser after the first run.
 */

import type {
  AutomaticSpeechRecognitionPipeline,
  pipeline as Pipeline,
  env as TransformersEnvValue,
} from '@huggingface/transformers'

export interface Progress {
  // -1 when the work is indeterminate.
  ratio: number
  detail: string
}

/**
 * One model per device type, because the two devices are not in the same
 * performance class. The WASM path is single-threaded (nothing here sets the
 * cross-origin isolation headers that would unlock threads), so it gets the
 * smaller model of each pair.
 *
 * The encoder is where a Whisper model's accuracy lives, so it stays `fp32` on
 * both. The decoder is quantised, but not identically: `q4` is what Hugging
 * Face's own WebGPU Whisper demos ship, while `q8` is the WASM default and does
 * not hit the WebGPU-specific breakage that makes `q8` produce gibberish there.
 */
export interface WhisperChoice {
  webgpu: string
  wasm: string
}

const WEBGPU_DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q4' } as const
const WASM_DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q8' } as const

export interface Transcriber {
  pipeline: AutomaticSpeechRecognitionPipeline
  webgpu: boolean
}

type TransformersEnv = typeof TransformersEnvValue

/**
 * `navigator.gpu` is a browser capability, not an ONNX Runtime one, and the gap
 * between the two is a trap. The WebGPU execution provider is compiled only
 * into the `asyncify` and `jspi` runtime builds, and Transformers.js
 * deliberately points Safari at the plain build to dodge an Asyncify memory
 * leak on Apple devices - so on iPad Safari `navigator.gpu` exists but session
 * creation throws `webgpuInit is not a function`.
 *
 * Asking the runtime which build it loaded, rather than sniffing the user
 * agent, means this re-enables itself if upstream ever lifts the carve-out.
 */
function webgpuUsable (env: TransformersEnv): boolean {
  if (!('gpu' in navigator)) {
    return false
  }
  const paths = env.backends?.onnx?.wasm?.wasmPaths
  if (typeof paths !== 'object' || typeof paths.mjs !== 'string') {
    return true
  }
  return paths.mjs.includes('asyncify') || paths.mjs.includes('jspi')
}

/**
 * Loads the pipeline for whichever device this browser can actually run.
 *
 * The device has to be decided before the first session, not caught around it.
 * Transformers.js chains every session creation onto one module-level promise
 * with no `.catch`, so one rejection poisons that promise for the lifetime of
 * the page: `rejected.then(load)` never runs `load`, and every later attempt
 * re-throws the *first* error. A try/catch that retries on another device would
 * therefore report the original WebGPU failure and look like the fallback
 * silently never ran. Do not replace the up-front check with a retry.
 */
export async function loadTranscriber (
  models: WhisperChoice,
  onProgress: (progress: Progress) => void,
): Promise<Transcriber> {
  // Dynamic so the ~500 kB library chunk and the 22 MB ONNX Runtime WASM stay
  // out of the initial load. Keep it that way.
  const { env, pipeline } = await import('@huggingface/transformers')
  return build(pipeline, env, models, onProgress)
}

async function build (
  pipeline: typeof Pipeline,
  env: TransformersEnv,
  models: WhisperChoice,
  onProgress: (progress: Progress) => void,
): Promise<Transcriber> {
  const webgpu = webgpuUsable(env)
  const options = {
    device: webgpu ? 'webgpu' as const : 'wasm' as const,
    dtype: webgpu ? WEBGPU_DTYPE : WASM_DTYPE,
    progress_callback: (event: { status: string, progress?: number, file?: string }) => {
      if (event.status === 'progress' && event.progress !== undefined) {
        onProgress({
          ratio: event.progress / 100,
          detail: `Downloading model: ${event.file ?? ''}`,
        })
      }
    },
  }

  const loaded = await pipeline(
    'automatic-speech-recognition',
    webgpu ? models.webgpu : models.wasm,
    options,
  )
  return { pipeline: loaded as AutomaticSpeechRecognitionPipeline, webgpu }
}

export function transcriptionText (output: unknown): string {
  const result = Array.isArray(output) ? output[0] : output
  return String((result as { text?: string }).text ?? '').trim()
}
