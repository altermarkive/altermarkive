/**
 * lib/transcribeFile.ts
 *
 * Transcription using Whisper through Transformers.js.
 *
 * The model weights come from the Hugging Face CDN at runtime, not from this
 * site, and Transformers.js caches them in the browser after the first run.
 */

import type {
  AutomaticSpeechRecognitionPipeline,
  pipeline as Pipeline,
} from '@huggingface/transformers'
import { decodeToMono16k } from '@/lib/audio'

// whisper-base.en: English-only, so no language token to get wrong.
const MODEL = 'onnx-community/whisper-base.en'

// fp32 encoder, q4 decoder. At this size fp32 costs 82 MB, so the accuracy of a
// small model is worth keeping rather than quantising away.
const DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q4' } as const

// Combined size of the two files, for the warning in the dialog.
export const MODEL_DOWNLOAD_MB = 197

// Plain Whisper is trained on a 30 s window, and the
// stride is the usual chunk/6 of overlap on each side.
const CHUNK_LENGTH_S = 30
const STRIDE_LENGTH_S = 5

export interface Progress {
  // -1 when the work is indeterminate.
  ratio: number
  detail: string
}

interface Chunk { text?: string }

export function isFileTranscriptionSupported (): boolean {
  return typeof AudioContext !== 'undefined'
}

export function hasWebGPU (): boolean {
  return 'gpu' in navigator
}

async function loadTranscriber (
  pipeline: typeof Pipeline,
  onProgress: (progress: Progress) => void,
): Promise<[AutomaticSpeechRecognitionPipeline, boolean]> {
  const options = {
    dtype: DTYPE,
    progress_callback: (event: { status: string, progress?: number, file?: string }) => {
      if (event.status === 'progress' && event.progress !== undefined) {
        onProgress({
          ratio: event.progress / 100,
          detail: `Downloading model: ${event.file ?? ''}`,
        })
      }
    },
  }

  if (hasWebGPU()) {
    try {
      const transcriber = await pipeline('automatic-speech-recognition', MODEL, {
        ...options,
        device: 'webgpu',
      })
      return [transcriber as AutomaticSpeechRecognitionPipeline, true]
    } catch (error) {
      console.warn('WebGPU unavailable to the ONNX runtime, falling back to CPU', error)
      onProgress({ ratio: -1, detail: 'GPU unavailable, retrying on CPU...' })
    }
  }

  const transcriber = await pipeline('automatic-speech-recognition', MODEL, {
    ...options,
    device: 'wasm',
  })
  return [transcriber as AutomaticSpeechRecognitionPipeline, false]
}

export async function transcribeFile (
  file: File,
  onProgress: (progress: Progress) => void,
): Promise<string[]> {
  onProgress({ ratio: -1, detail: 'Decoding audio...' })
  const audio = await decodeToMono16k(file)

  const { pipeline } = await import('@huggingface/transformers')
  const [transcriber, webgpu] = await loadTranscriber(pipeline, onProgress)

  const minutes = Math.max(1, Math.round(audio.length / 16_000 / 60))
  onProgress({
    ratio: -1,
    detail: `Transcribing ${minutes} min on ${webgpu ? 'GPU' : 'CPU'}...`,
  })

  const output = await transcriber(audio, {
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    return_timestamps: true,
  })

  const result = Array.isArray(output) ? output[0] : output
  // Timestamped chunks give one line per utterance, matching the granularity
  // the live path produces; the flat text is the fallback if they are absent.
  const chunks = (result as { chunks?: Chunk[] }).chunks
  const lines = chunks?.length
    ? chunks.map(chunk => (chunk.text ?? '').trim())
    : String((result as { text?: string }).text ?? '').split('\n')

  return lines.filter(line => line.length > 0)
}
