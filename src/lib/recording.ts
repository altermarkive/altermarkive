/**
 * lib/recording.ts
 *
 * Which of the two live paths a recording session uses.
 *
 * 'speech' is the Web Speech API: the browser owns the microphone and a remote
 * speech service does the transcribing, which is fast but unavailable in
 * browsers that have no such service to reach.
 *
 * 'universal' captures the microphone here and transcribes on the device, so it
 * runs anywhere `getUserMedia` does, at the cost of a model download and a
 * lag of about one pause.
 */

export type RecordingPath = 'speech' | 'universal'
