/**
 * composables/useCamera.ts
 *
 * Camera enumeration, preview and still capture.
 * The capture goes straight into the Anthropic request rather than being
 * POSTed to /screenshot for the server to hold.
 */

import { onScopeDispose, ref, shallowRef } from 'vue'

export interface Capture {
  base64: string
  width: number
  height: number
  bytes: number
}

export interface CameraOption {
  title: string
  value: string
}

const MEDIA_TYPE = 'image/jpeg'
const QUALITY = 0.9

export function useCamera () {
  const cameras = ref<CameraOption[]>([])
  const selected = ref('')
  const video = ref<HTMLVideoElement>()

  const stream = shallowRef<MediaStream>()

  // Labels are empty until camera permission is granted, and Safari drops them
  // again on reload - without a fallback the picker renders blank rows.
  async function listCameras () {
    const devices = await navigator.mediaDevices.enumerateDevices()
    cameras.value = devices
      .filter(device => device.kind === 'videoinput')
      .map((device, index) => ({
        title: device.label || `Camera ${index + 1}`,
        value: device.deviceId,
      }))
    if (!cameras.value.some(camera => camera.value === selected.value)) {
      selected.value = cameras.value[0]?.value ?? ''
    }
  }

  async function startCamera () {
    for (const track of stream.value?.getTracks() ?? []) {
      track.stop()
    }
    stream.value = undefined
    try {
      stream.value = await navigator.mediaDevices.getUserMedia({
        video: selected.value ? { deviceId: { exact: selected.value } } : true,
      })
    } catch (error) {
      // Safari reissues deviceIds across reloads, so a remembered one can name
      // a device that no longer exists; fall back to whatever camera there is.
      if (!selected.value) {
        throw error
      }
      selected.value = ''
      stream.value = await navigator.mediaDevices.getUserMedia({ video: true })
    }
    const element = video.value
    if (element) {
      element.srcObject = stream.value
      await element.play()
    }
    // Labels become readable only once a stream exists, so relist here to turn
    // the "Camera N" placeholders into real device names.
    await listCameras()
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

    const bytes = new Uint8Array(await blob.arrayBuffer())
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

  const onDeviceChange = () => {
    listCameras()
  }
  navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)
  onScopeDispose(() => {
    navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
  })

  return { cameras, selected, video, listCameras, startCamera, capture, stopCamera }
}
