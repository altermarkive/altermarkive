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
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="!apiKey" text="Record" variant="tonal" @click="record" />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
  import { ref, watch } from 'vue'
  import { recognitionUnavailable } from '@/composables/useRecognition'
  import { MODELS } from '@/lib/anthropic'
  import { loadSettings, saveSettings } from '@/lib/settings'

  const open = defineModel<boolean>({ required: true })

  const emit = defineEmits<{ record: [] }>()

  const unavailable = recognitionUnavailable()
  const reveal = ref(false)

  const settings = loadSettings()
  const apiKey = ref(settings.apiKey)
  const model = ref(settings.model)

  watch(open, isOpen => {
    if (isOpen) {
      const stored = loadSettings()
      apiKey.value = stored.apiKey
      model.value = stored.model
    }
  })

  function record () {
    saveSettings({ apiKey: apiKey.value, model: model.value })
    open.value = false
    emit('record')
  }
</script>
