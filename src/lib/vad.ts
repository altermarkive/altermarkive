/**
 * lib/vad.ts
 *
 * Energy-envelope Voice Activity Detection, ported from the accumulator the
 * Python server used (`old/souffleur.py`, `VadAccumulator`) before this app
 * moved into the browser. Same feed/flush contract, same constants.
 *
 * A frame is a small fixed-size slice of samples - the unit the VAD looks at
 * one at a time rather than all at once. At 16 kHz, 20 ms is 320 samples, and
 * every call to `feed()` takes exactly that many. 20 ms is the usual choice in
 * speech processing because it matches the time scale of a phoneme: short
 * enough that speech/silence transitions are caught quickly, long enough that
 * the RMS energy is stable rather than fooled by individual waveform peaks. At
 * 10 ms the energy estimate gets noisy; at 40 ms fast transitions start to slip
 * through.
 *
 * In noisier rooms (music, HVAC, a keyboard) the single RMS threshold
 * false-triggers and hands non-speech to Whisper. A drop-in replacement using
 * Silero VAD keeps this same contract - it would need the window fixed at 512
 * samples, which is what Silero wants at 16 kHz, and the RMS comparison
 * replaced by model inference. That trade is deliberately not taken here: it
 * means a second ONNX Runtime session on a page where Transformers.js already
 * chains every session onto one promise that a single rejection poisons.
 */

export const SAMPLE_RATE = 16_000

const FRAME_MS = 20
const ENERGY_THRESHOLD = 0.01
const MIN_SPEECH_MS = 300

// The class default was 800 ms, but the server ran with `--min-silence-ms 600`,
// which is the value that actually saw use.
const MIN_SILENCE_MS = 600

// A cap rather than a preference: without it, someone talking continuously
// produces no transcript at all until they pause, and the segment would run
// past the 30 s window Whisper is trained on.
const MAX_SPEECH_MS = 15_000

export interface VadOptions {
  frameMs?: number
  energyThreshold?: number
  minSilenceMs?: number
  minSpeechMs?: number
  maxSpeechMs?: number
}

export class VadAccumulator {
  readonly frameSamples: number

  readonly #minSilenceFrames: number
  readonly #minSpeechFrames: number
  readonly #maxSpeechSamples: number
  readonly #energyThreshold: number

  #buffer: Float32Array[] = []
  #buffered = 0
  #speechFrames = 0
  #silenceFrames = 0
  #inSpeech = false

  constructor ({
    frameMs = FRAME_MS,
    energyThreshold = ENERGY_THRESHOLD,
    minSilenceMs = MIN_SILENCE_MS,
    minSpeechMs = MIN_SPEECH_MS,
    maxSpeechMs = MAX_SPEECH_MS,
  }: VadOptions = {}) {
    this.frameSamples = Math.trunc(SAMPLE_RATE * frameMs / 1000)
    this.#minSilenceFrames = Math.trunc(minSilenceMs / frameMs)
    this.#minSpeechFrames = Math.trunc(minSpeechMs / frameMs)
    this.#maxSpeechSamples = Math.trunc(maxSpeechMs / 1000 * SAMPLE_RATE)
    this.#energyThreshold = energyThreshold
  }

  /**
   * Takes one frame and returns a segment when the frame completed one:
   * either a pause long enough to be an utterance boundary, or the cap.
   */
  feed (frame: Float32Array): Float32Array | undefined {
    if (rms(frame) >= this.#energyThreshold) {
      this.#append(frame)
      this.#speechFrames += 1
      this.#silenceFrames = 0
      this.#inSpeech = true
      if (this.#buffered >= this.#maxSpeechSamples) {
        return this.flush()
      }
    } else if (this.#inSpeech) {
      // Kept, not dropped: a pause shorter than the threshold is part of the
      // utterance, and Whisper transcribes better with it left in.
      this.#append(frame)
      this.#silenceFrames += 1
      if (this.#silenceFrames >= this.#minSilenceFrames) {
        return this.flush()
      }
    }
    return undefined
  }

  /** Emits whatever is buffered, if it holds enough speech to be worth it. */
  flush (): Float32Array | undefined {
    const segment = this.#speechFrames >= this.#minSpeechFrames
      ? concatenate(this.#buffer, this.#buffered)
      : undefined
    this.#buffer = []
    this.#buffered = 0
    this.#speechFrames = 0
    this.#silenceFrames = 0
    this.#inSpeech = false
    return segment
  }

  #append (frame: Float32Array) {
    this.#buffer.push(frame)
    this.#buffered += frame.length
  }
}

function rms (frame: Float32Array): number {
  let total = 0
  for (const sample of frame) {
    total += sample * sample
  }
  return Math.sqrt(total / frame.length)
}

function concatenate (frames: Float32Array[], length: number): Float32Array {
  const segment = new Float32Array(length)
  let offset = 0
  for (const frame of frames) {
    segment.set(frame, offset)
    offset += frame.length
  }
  return segment
}

/**
 * Blocks arriving from the audio thread are 128 samples and never line up with
 * a 320-sample frame, so the remainder has to be carried between calls. This is
 * the `residue` loop.
 */
export class FrameSplitter {
  #residue = new Float32Array(0)

  readonly #frameSamples: number

  constructor (frameSamples: number) {
    this.#frameSamples = frameSamples
  }

  split (block: Float32Array, onFrame: (frame: Float32Array) => void) {
    const combined = new Float32Array(this.#residue.length + block.length)
    combined.set(this.#residue)
    combined.set(block, this.#residue.length)

    let offset = 0
    while (combined.length - offset >= this.#frameSamples) {
      onFrame(combined.subarray(offset, offset + this.#frameSamples))
      offset += this.#frameSamples
    }
    // Copied rather than kept as a view, so the combined buffer can be freed.
    this.#residue = combined.slice(offset)
  }

  reset () {
    this.#residue = new Float32Array(0)
  }
}
