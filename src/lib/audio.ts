/**
 * lib/audio.ts
 *
 * Decoding an uploaded recording into what the ASR model wants: 16 kHz mono.
 */

const TARGET_SAMPLE_RATE = 16_000

/**
 * Decoding inside a 16 kHz AudioContext resamples during the decode rather than
 * after it, so a full-rate copy never exists: an hour of 48 kHz stereo lands as
 * ~440 MB instead of ~1.3 GB, and ~220 MB once downmixed.
 */
export async function decodeToMono16k (file: File): Promise<Float32Array> {
  const bytes = await file.arrayBuffer()
  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  try {
    const buffer = await context.decodeAudioData(bytes)
    return downmix(buffer)
  } finally {
    await context.close()
  }
}

function downmix (buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0)
  }
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel)
    for (const [index, sample] of samples.entries()) {
      mono[index] += sample
    }
  }
  for (const [index, sample] of mono.entries()) {
    mono[index] = sample / buffer.numberOfChannels
  }
  return mono
}
