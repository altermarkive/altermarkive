/**
 * lib/settings.ts
 *
 * The API key (Anthropic or OpenAI) and solving model.
 */

import { resolveModel } from '@/lib/solver'

const API_KEY_STORAGE = 'souffleur.apiKey'
const MODEL_STORAGE = 'souffleur.model'

export interface Settings {
  apiKey: string
  model: string
}

export function loadSettings (): Settings {
  const apiKey = localStorage.getItem(API_KEY_STORAGE) ?? ''
  return {
    apiKey,
    model: resolveModel(apiKey, localStorage.getItem(MODEL_STORAGE) ?? ''),
  }
}

export function saveSettings (settings: Settings): void {
  localStorage.setItem(API_KEY_STORAGE, settings.apiKey)
  localStorage.setItem(MODEL_STORAGE, settings.model)
}
