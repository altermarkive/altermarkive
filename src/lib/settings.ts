/**
 * lib/settings.ts
 *
 * The Anthropic API key and solving model.
 */

import { DEFAULT_MODEL } from '@/lib/anthropic'

const API_KEY_STORAGE = 'souffleur.apiKey'
const MODEL_STORAGE = 'souffleur.model'

export interface Settings {
  apiKey: string
  model: string
}

export function loadSettings (): Settings {
  return {
    apiKey: localStorage.getItem(API_KEY_STORAGE) ?? '',
    model: localStorage.getItem(MODEL_STORAGE) ?? DEFAULT_MODEL,
  }
}

export function saveSettings (settings: Settings): void {
  localStorage.setItem(API_KEY_STORAGE, settings.apiKey)
  localStorage.setItem(MODEL_STORAGE, settings.model)
}
