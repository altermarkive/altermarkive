/**
 * composables/useCamera.ts
 *
 * Camera enumeration, preview and still capture.
 * The base64 goes straight into the Anthropic request.
 */

import { ref, shallowRef } from 'vue'

export interface Capture {
  base64: string
  width: number
  height: number
  bytes: number
}

const MEDIA_TYPE = 'image/jpeg'
const QUALITY = 0.9

export function useCamera () {
  const cameras = ref<MediaDeviceInfo[]>([])
  const selected = ref('')
  const video = ref<HTMLVideoElement>()

  const stream = shallowRef<MediaStream>()

  async function listCameras () {
    const devices = await navigator.mediaDevices.enumerateDevices()
    cameras.value = devices.filter(device => device.kind === 'videoinput')
    if (!selected.value) {
      selected.value = cameras.value[0]?.deviceId ?? ''
    }
  }

  async function startCamera () {
    for (const track of stream.value?.getTracks() ?? []) {
      track.stop()
    }
    stream.value = await navigator.mediaDevices.getUserMedia({
      video: selected.value ? { deviceId: { exact: selected.value } } : true,
    })
    const element = video.value
    if (element) {
      element.srcObject = stream.value
      await element.play()
    }
  }

  async function capture (): Promise<Capture | undefined> {
    if (!stream.value) {
      await startCamera()
    }
    const element = video.value
    if (!element || !element.videoWidth) {
      return undefined
    }

    const canvas = document.createElement('canvas')
    canvas.width = element.videoWidth
    canvas.height = element.videoHeight
    canvas.getContext('2d')?.drawImage(element, 0, 0)

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, MEDIA_TYPE, QUALITY)
    })
    if (!blob) {
      return undefined
    }

    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCodePoint(byte)
    }

    return {
      base64: btoa(binary),
      width: canvas.width,
      height: canvas.height,
      bytes: blob.size,
    }
  }

  function stopCamera () {
    for (const track of stream.value?.getTracks() ?? []) {
      track.stop()
    }
    stream.value = undefined
  }

  return { cameras, selected, video, listCameras, startCamera, capture, stopCamera }
}
