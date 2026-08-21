/**
 * lib/transcribeFile.ts
 *
 * Offline transcription of an uploaded recording, using Whisper through
 * Transformers.js. This is the opposite trade to the live path: the Web Speech
 * API cannot be fed audio (its `start()` takes no MediaStreamTrack outside a
 * Chrome flag), and a file is not latency-critical, so a local model wins.
 *
 * The model weights come from the Hugging Face CDN at runtime, not from this
 * site, and Transformers.js caches them in the browser after the first run.
 */

import { decodeToMono16k } from '@/lib/audio'

// distil-large-v3.5: the maintained successor to distil-large-v3, and the one
// with a Transformers.js ONNX build. Roughly whisper-large-v3 quality.
const MODEL = 'onnx-community/distil-large-v3.5-ONNX'

// q4 for both halves: the fp32 encoder needs a 2.4 GB external-data file, and
// fp16 needs `shader-f16`, which plenty of GPUs (including Ampere) lack.
const WEBGPU_DTYPE = { encoder_model: 'q4', decoder_model_merged: 'q4' } as const
const WASM_DTYPE = { encoder_model: 'q8', decoder_model_merged: 'q8' } as const

// Combined size of the two q4 files, for the warning in the dialog.
export const MODEL_DOWNLOAD_MB = 692

// distil-whisper is trained for a longer window than Whisper's 30 s.
const CHUNK_LENGTH_S = 25
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

export async function transcribeFile (
  file: File,
  onProgress: (progress: Progress) => void,
): Promise<string[]> {
  onProgress({ ratio: -1, detail: 'Decoding audio...' })
  const audio = await decodeToMono16k(file)

  const { pipeline } = await import('@huggingface/transformers')
  const webgpu = hasWebGPU()

  const transcriber = await pipeline('automatic-speech-recognition', MODEL, {
    device: webgpu ? 'webgpu' : 'wasm',
    dtype: webgpu ? WEBGPU_DTYPE : WASM_DTYPE,
    progress_callback: (event: { status: string, progress?: number, file?: string }) => {
      if (event.status === 'progress' && event.progress !== undefined) {
        onProgress({
          ratio: event.progress / 100,
          detail: `Downloading model: ${event.file ?? ''}`,
        })
      }
    },
  })

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
