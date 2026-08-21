import vuetify from 'eslint-config-vuetify'

export default [
  // eslint-config-vuetify lints YAML with a JavaScript comment rule, so every
  // `#` comment in pnpm's config is reported as a malformed block comment.
  // That file belongs to pnpm, not to the JavaScript sources.
  { ignores: ['pnpm-workspace.yaml'] },
  ...await vuetify({ ts: true }),
]
