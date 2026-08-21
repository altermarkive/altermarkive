<template>
  <v-dialog v-model="open" max-width="520" persistent>
    <v-card title="Souffleur">
      <v-card-text>
        <v-text-field
          v-model="apiKey"
          :append-inner-icon="reveal ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="off"
          hint="Stored in this browser's LocalStorage and sent directly to the Anthropic API."
          label="Anthropic API key"
          persistent-hint
          :type="reveal ? 'text' : 'password'"
          @click:append-inner="reveal = !reveal"
        />

        <v-select
          v-model="model"
          class="mt-6"
          :items="MODELS"
          label="Solve model"
        />

        <v-alert
          v-if="unavailable"
          class="mt-6"
          :text="unavailable"
          type="warning"
          variant="tonal"
        />

        <div class="mt-6 text-xs opacity-70">
          Audio inputs seen by this browser: {{ audioInputs.join(', ') || 'none' }}.
        </div>

        <v-divider class="mt-6" />

        <div class="mt-6">
          <input
            ref="picker"
            accept="audio/mp4,audio/x-m4a,audio/mpeg,audio/wav,.m4a"
            class="hidden"
            type="file"
            @change="onFile"
          >

          <div class="text-xs opacity-70">
            Upload recording works on Chrome only. Transcribes the file locally
            and loads it into the Transcript tab, replacing what is there. First
            run downloads about {{ MODEL_DOWNLOAD_MB }} MB of model weights from
            Hugging Face, then caches them.
          </div>

          <template v-if="busy">
            <v-progress-linear
              class="mt-4"
              :indeterminate="progress.ratio < 0"
              :model-value="progress.ratio * 100"
            />

            <div class="mt-2 text-xs">{{ progress.detail }}</div>
          </template>

          <div v-else-if="uploadError" class="mt-2 text-xs text-error">
            {{ uploadError }}
          </div>
        </div>
      </v-card-text>

      <v-card-actions>
        <v-btn :disabled="busy" text="Cancel" variant="text" @click="cancel" />

        <v-spacer />

        <v-btn
          :disabled="busy"
          :loading="busy"
          text="Upload recording"
          variant="tonal"
          @click="picker?.click()"
        />

        <v-btn :disabled="!apiKey || busy" text="Record" variant="tonal" @click="record" />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
  import { ref, useTemplateRef, watch } from 'vue'
  import { recognitionUnavailable } from '@/composables/useRecognition'
  import { MODELS } from '@/lib/anthropic'
  import { loadSettings, saveSettings } from '@/lib/settings'
  import { MODEL_DOWNLOAD_MB, type Progress, transcribeFile } from '@/lib/transcribeFile'

  const open = defineModel<boolean>({ required: true })

  const emit = defineEmits<{
    record: []
    transcribed: [lines: string[], name: string]
  }>()

  const picker = useTemplateRef<HTMLInputElement>('picker')
  const busy = ref(false)
  const uploadError = ref('')
  const progress = ref<Progress>({ ratio: -1, detail: '' })

  async function onFile (event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) {
      return
    }

    busy.value = true
    uploadError.value = ''
    progress.value = { ratio: -1, detail: 'Starting...' }
    try {
      const lines = await transcribeFile(file, update => {
        progress.value = update
      })
      emit('transcribed', lines, file.name)
    } catch (error) {
      uploadError.value = `Transcription failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    } finally {
      busy.value = false
      input.value = ''
    }
  }

  const unavailable = recognitionUnavailable()
  const reveal = ref(false)

  // Diagnostic: which microphones the platform reports. Labels stay empty until
  // permission is granted, so fall back to a count that is still informative.
  const audioInputs = ref<string[]>([])

  async function listAudioInputs () {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      audioInputs.value = devices
        .filter(device => device.kind === 'audioinput')
        .map((device, index) => device.label || `Microphone ${index + 1}`)
    } catch {
      audioInputs.value = []
    }
  }

  const settings = loadSettings()
  const apiKey = ref(settings.apiKey)
  const model = ref(settings.model)

  // The dialog is already open at mount, so the watcher never fires for the
  // first showing.
  listAudioInputs()

  watch(open, isOpen => {
    if (isOpen) {
      listAudioInputs()
      const stored = loadSettings()
      apiKey.value = stored.apiKey
      model.value = stored.model
    }
  })

  function cancel () {
    open.value = false
  }

  function record () {
    saveSettings({ apiKey: apiKey.value, model: model.value })
    open.value = false
    emit('record')
  }
</script>
