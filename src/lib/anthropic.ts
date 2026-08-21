/**
 * lib/anthropic.ts
 *
 * The solver. The API is called straight from the browser,
 * so the key lives in LocalStorage and is visible to anyone with the
 * device - acceptable only because this is a single-user tool.
 */

import Anthropic from '@anthropic-ai/sdk'
import { PROMPT_SOLUTION } from '@/lib/prompt'

export const DEFAULT_MODEL = 'claude-sonnet-5'

export const MODELS = [
  { title: 'Sonnet 5 (faster)', value: 'claude-sonnet-5' },
  { title: 'Opus 5 (thorough, slower)', value: 'claude-opus-5' },
]

const SCREENSHOT_MEDIA_TYPE = 'image/jpeg'

// Thinking tokens are drawn from the same budget as the answer, so the solver
// needs headroom - without it a long deliberation eats the budget and the
// answer is truncated mid-sentence.
const SOLVE_MAX_TOKENS = 8192

// The solver spots the question and answers it in one request, so it carries
// the whole live path on its own. Adaptive thinking at low effort buys answer
// quality without the turnaround a higher effort would add.
const SOLVE_EFFORT = 'low'

export interface Answer {
  // The question the model identified; blank if it emitted no "QUESTION:" line.
  question: string
  text: string
}

export function createClient (apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
}

// Joins the text blocks, dropping thinking blocks.
export function responseText (content: Anthropic.ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function splitQuestion (text: string): { question: string, answer: string } {
  const lines = text.split('\n')
  const index = lines.findIndex(line => line.startsWith('QUESTION:'))
  if (index === -1) {
    return { question: '', answer: text }
  }
  return {
    question: lines[index].slice('QUESTION:'.length).trim(),
    answer: lines.slice(index + 1).join('\n').trim(),
  }
}

export async function solve (
  client: Anthropic,
  model: string,
  transcript: string,
  screenshot: string,
): Promise<Answer> {
  const content: Anthropic.ContentBlockParam[] = []
  if (screenshot) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: SCREENSHOT_MEDIA_TYPE, data: screenshot },
    })
  }
  content.push({
    type: 'text',
    text: PROMPT_SOLUTION.replace('{transcript}', transcript || '(empty)'),
  })

  const response = await client.messages.create({
    model,
    max_tokens: SOLVE_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: SOLVE_EFFORT },
    messages: [{ role: 'user', content }],
  })

  const { question, answer } = splitQuestion(responseText(response.content))
  return { question, text: answer }
}
