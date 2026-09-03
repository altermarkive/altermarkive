# Souffleur

Proof-of-concept for use when practicing interviews or exams - [try it out](https://marek-burza.github.io/souffleur/) (deployed as a static site on GitHub Pages)!

An Anthropic or OpenAI API key is entered in a dialog and kept in `LocalStorage`.

## 🏛️ Architecture

`src/App.vue` is the only stateful component. It owns the composables and passes
plain values down; the child components hold no session state.

```text
useRecognition(addLine) ──────────┐
useUniversalRecognition(addLine) ─┴> useTranscript ──> TranscriptPane (editable)
useCamera ──> CameraPreview + capture() ──┐
                                          ├─> lib/solver solve() ──> AnswerPane
SettingsDialog (key, model, file upload) ─┘
```

Three transcription paths, one `addLine` contract: each emits a line per utterance
and none of them knows about the others. `App.vue` stops whichever is running before
starting another, since all three want the same microphone.

### 🔑 Providers

`src/lib/solver.ts` talks to both providers through LangChain, and the key picks
which one: `sk-ant-` means `ChatAnthropic`, anything else `ChatOpenAI`. There is
deliberately no provider toggle, since a toggle can disagree with the key. The
model dropdown follows the same inference, and `resolveModel()` drops a stored
model that belongs to the other provider (so replacing the key cannot leave a
model name the new provider would reject).

Calling either API from a page means acknowledging it, and each SDK spells that
differently: `clientOptions: { dangerouslyAllowBrowser: true }` for Anthropic,
`configuration: { dangerouslyAllowBrowser: true }` for OpenAI. LangChain forwards
both verbatim to the underlying client constructor. Nothing about this is a
proxy - the build stays a static site.

Both effort controls are native LangChain constructor fields, not passthrough
kwargs: `thinking: { type: 'adaptive' }` with `outputConfig: { effort }` on
`ChatAnthropic`, and `reasoning: { effort }` on `ChatOpenAI` (the flat
`reasoningEffort` is deprecated in favour of it). They reach the wire as
`thinking` + `output_config` and as `reasoning_effort` respectively. Note that
`reasoning.effort` alone does **not** move OpenAI onto the Responses API:
`_useResponsesApi()` switches only on `reasoning.summary`, built-in or custom
tools, or a model name matching its `-pro`/`codex` list. `gpt-5.6-*` therefore
goes to `/v1/chat/completions`, which is fine - `maxTokens` becomes
`max_completion_tokens` there.

### 🛣️ Transcription Paths

**Live** (the `Record` button) uses the Web Speech API
(`src/composables/useRecognition.ts`). It cannot be pointed at a microphone or fed
audio: `SpeechRecognition` has no device property and `start()` takes no
`MediaStreamTrack` outside a Chrome flag. It owns the mic and uses the system
default, and it does its own endpointing, emitting one final result per utterance -
so this path has no VAD of its own.

Because that API is unreliable in the field, the composable restarts on every `end`,
keeps a 10s watchdog for the silent-death case, and backs off exponentially
(`RESTART_DELAY_MS` → `MAX_RESTART_DELAY_MS`) so a hard failure cannot spin.
A restart is lossy, since the mic is not captured until the next instance starts, so
a session that ended healthy (`failures === 0`) waits only `HEALTHY_RESTART_DELAY_MS`.
Browsers cap session length even mid-utterance, so `end` also commits any pending
interim text: no final result was delivered for those words, and the `result` handler
clears `interim` whenever it commits a final one, so this cannot duplicate a line.
That recovery is the *only* reason `interimResults` is on. Nothing displays a
partial utterance - the pane gets a line once it is final - so `interim` is a plain
local the composable does not return. Turning `interimResults` off would silently
lose whatever a capped session was in the middle of hearing.
`start()` throwing is its own restart path - an instance that never started fires no
events, so nothing else would come back around.
`recognitionUnavailable()` detects plain Chromium by User-Agent brands: such builds
ship without Google's API keys, so the constructor exists and the mic opens but every
attempt ends `audiostart → audioend → error: network`.

**Live, universal** (the `Record (universal)` button,
`src/composables/useUniversalRecognition.ts`) is the path for browsers where the one
above cannot run at all - plain Chromium, Firefox - and it needs nothing but a
microphone. It captures the mic itself and transcribes on the device:

- `src/lib/micStream.ts` is the `getUserMedia` + `AudioWorklet` capture, ported from
  the pre-Vue page (`old/souffleur.html`, recoverable at `491e246^`), with the
  WebSocket send replaced by a callback. Two details from it are load-bearing: the
  worklet is published as a **blob URL** rather than a bundled asset, which sidesteps
  `base: '/souffleur/'` entirely, and the worklet is connected through a zero-gain
  node to `destination`, because a graph that reaches no destination is never pulled.
  The `AudioContext` is fixed at 16 kHz so resampling happens in the graph and
  nothing downstream has to do it.
- `src/lib/vad.ts` is the energy VAD ported from the Python server
  (`old/souffleur.py`, `VadAccumulator`), constants intact: 20 ms frames, RMS
  threshold `0.01`, 300 ms minimum speech, 600 ms of silence to end a segment (the
  class default was 800, but the server ran with `--min-silence-ms 600`), and a
  15 s cap. The cap is not a preference: without it someone talking continuously
  produces no transcript until they pause, and the segment would outrun Whisper's
  30 s window. `FrameSplitter` is the `residue` loop from the WebSocket handler -
  worklet blocks are 128 samples and never align with a 320-sample frame.
- A single RMS threshold false-triggers on music, HVAC and keyboards. Silero via
  ONNX would fix that and keeps the same feed/flush contract, but it means a second
  ONNX Runtime session on a page whose *first* one already sits behind the poisoned
  promise described below, and it competes with Whisper decode for the same cores on
  exactly the device that has none to spare. Pre-speech padding, dual thresholds and
  an adaptive noise floor are the cheaper fixes if the fixed threshold misbehaves.
- Segments are decoded **one at a time** - the pipeline is not reentrant - and the
  queue drops its oldest entry past `MAX_PENDING`, so a device that cannot keep up
  loses an utterance instead of drifting further behind on every one after it. The
  segment is handed over with no `chunk_length_s`: the VAD already capped it below
  the 30 s window, so chunking would only add cost.

**File upload** (`src/lib/transcribeFile.ts`) exists precisely because Web Speech
cannot accept audio. It runs the whole file through Whisper in one call, which is
what lets it afford the larger model of each pair.

Both local paths share `src/lib/whisper.ts` for loading. Notes that matter:

- The `@huggingface/transformers` import is **dynamic** so the ~500 kB chunk and the
  22 MB ONNX Runtime WASM stay out of the initial load. Keep it that way.
- **One model per device type, per path.** File upload gets
  `onnx-community/whisper-small.en` on WebGPU and `onnx-community/whisper-base.en`
  on WASM; the universal live path steps both down, to base.en and tiny.en. The
  WASM path is single-threaded (see cross-origin isolation below), and small.en's
  encoder is ~350 GFLOP per 30 s window against base's ~90, so on CPU small runs
  1.5-3x slower than real time and base comfortably under it. That is survivable
  for a file, which only has to finish, and fatal live, where decoding has to keep
  ahead of speech - hence tiny.en on the CPU fallback. All four are English-only,
  so none needs a language token, and all are plain Whisper, so all want the 30 s
  window rather than distil-whisper's longer one.
- Every variant uses an `fp32` encoder (353 MB for small, 82 MB for base), because
  the encoder is where a Whisper model's accuracy lives. The decoder is quantised,
  but not identically: `q4` on WebGPU, which is what Hugging Face's own WebGPU
  Whisper demos ship, and `q8` on WASM, which is the WASM default and avoids the
  WebGPU-specific breakage that makes `q8` produce gibberish there.
- `navigator.gpu` is a browser capability, not an ONNX Runtime one, and the gap
  between the two is a trap. The WebGPU execution provider is compiled only into
  the `asyncify` and `jspi` runtime builds; Transformers.js deliberately points
  Safari at the plain build (`backends/onnx.js`, the `IS_SAFARI` branch) to dodge
  an Asyncify memory leak on Apple devices, so on iPad Safari `navigator.gpu`
  exists but session creation throws `webgpuInit is not a function`.
  `webgpuUsable()` therefore asks the *runtime* which build it loaded rather than
  sniffing the user agent, which means it re-enables itself if upstream ever
  lifts the carve-out.
- **That has to be checked before the first session, not caught around it.**
  Transformers.js chains every session creation onto one module-level promise
  with no `.catch` (`backends/onnx.js`, `webInitChain`). One rejection poisons
  that promise for the lifetime of the page: `rejected.then(load)` never runs
  `load`, so every later attempt re-throws the *first* error. A try/catch that
  retries on another device therefore reports the original WebGPU failure and
  looks like the fallback silently never ran. Do not replace the up-front check
  with a retry.
- `src/lib/audio.ts` decodes inside an `AudioContext({ sampleRate: 16000 })` so
  resampling happens *during* decode. An hour of 48 kHz stereo lands at ~440 MB
  instead of ~1.3 GB. Do not "simplify" this to a default AudioContext.

## 🚀 Bootstrap

Scaffolded with Vuetify CLI.

First:

```shell
podman run -it --rm --network host -v $PWD:/w -w /w --entrypoint /bin/sh node:26-alpine3.23
```

Then:

```shell
export PNPM_HOME=/root/.local/share/pnpm
export PATH="$PNPM_HOME:$PATH"
export SHELL=sh
touch ~/.shrc
export ENV=~/.shrc
npx get-pnpm
source ~/.shrc
pnpm create vuetify
# - Start from a preset? Start from scratch
# - Which framework would you like to use? Vue
# - Which CSS framework? Tailwind CSS
# - Select features to install? ESLint
```

## ❗️ Documentation

- Primary docs: https://vuetifyjs.com/
- Getting started guide: https://vuetifyjs.com/en/getting-started/installation/
- Community support: https://community.vuetifyjs.com/
- Issue tracker: https://issues.vuetifyjs.com/

## 📜 Project Rules & Conventions

- Follow the existing code style and patterns.
- Use pnpm for running all project commands.
- Keep code in TypeScript.

## 🧱 Stack

- Framework: Vue 3 + Vite
- UI Library: Vuetify
- Language: TypeScript
- Package manager: pnpm
- Enabled Features: ESLint, Tailwind CSS

## 🧭 Start Here

- Main entry: `src/main.ts`
- Main app component: `src/App.vue`
- Main styles: `src/styles/`
- Plugin setup: `src/plugins/`

## 📁 Project Structure

- `src/main.ts` - application entry point
- `src/App.vue` - root component
- `src/components/` - reusable Vue components
- `src/plugins/` - plugin registration and setup
- `src/styles/` - global styles and theme settings
- `public/` - static public files

## ✨ Enabled Features

- ESLint
- Tailwind CSS

## 💿 Install

Use your selected package manager (pnpm) to install dependencies:

```bash
pnpm install
```

## 🚀 Quick Start

```bash
pnpm install
pnpm dev
```

## 🏗️ Build

```bash
pnpm build
```

## 🧪 Available Scripts

- `pnpm dev`
- `pnpm build`
- `pnpm preview`
- `pnpm build-only`
- `pnpm type-check`
- `pnpm lint`
- `pnpm lint:fix`

There is no test suite and no test runner. Verify changes with `lint`, `type-check`,
`build`, and by driving the app in a browser. CI runs `install --frozen-lockfile`,
`lint`, then `build` - matching that sequence locally is the closest thing to a
pre-flight check.

## 💥 Gotchas

**Fonts flow through CSS variables.** `src/styles/tailwind.css` defines
`--font-heading/body/mono`, and `settings.scss` maps Vuetify's `$body-font-family` to
them. Changing the font is a three-line edit there, not SCSS surgery. Faces are
bundled by `unplugin-fonts` from `@fontsource-variable/*` - there are no CDN requests
anywhere in the build, and it should stay that way.

**`base: '/souffleur/'`** in `vite.config.mts` is required for project-page hosting.
Assets 404 without it.

**The layout has a stability contract.** `.shell` is `100dvh`, controls are
`flex: 0 0 auto`, and `.content` is `flex: 1 1 0; min-height: 0` so only the pane
inside the active tab scrolls. This keeps an arriving answer from shifting the
toolbar. `CameraPreview` has a fixed 64×40 box for the same reason: a `<video>` has no
intrinsic size until its stream starts.

**`eslint.config.js` ignores `pnpm-workspace.yaml`.** `eslint-config-vuetify` lints
YAML with a JavaScript comment rule, so *any* `#` comment there is reported as a
malformed block comment.

## 🔗 Dependencies

`pnpm-workspace.yaml` enforces the recommendations from
https://pnpm.io/supply-chain-security. The one that bites:

**`minimumReleaseAge: 10080`** - a package version must be a week old before it can be
resolved, and pnpm 11 checks this against the committed lockfile too. Adding a
freshly published dependency fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Either
target an older version, or add a specific `pkg@version` to `minimumReleaseAgeExclude`
if the exemption is genuinely justified.

`allowBuilds` denies install scripts for four Node-side transitive packages
(`@parcel/watcher`, `onnxruntime-node`, `protobufjs`, `sharp`) that a browser build
never loads. pnpm 11 treats an unapproved install script as a hard error, so a new
dependency with a postinstall must be added to that map explicitly.

The three `@langchain/*` packages release several times a week, so the version
ranges in `package.json` are floored at the newest release that was already a week
old when they were added. `@anthropic-ai/sdk` is no longer a direct dependency:
`@langchain/anthropic` pins its own (`^0.115.0`, which under a `0.x` caret means
`0.115.x` and not the `0.117` this project used to carry), and `@langchain/openai`
brings `openai` the same way. None of the five has an install script.

## 🚦 CI

`.github/workflows/souffleur.yml` builds and deploys to Pages on push to `main`. It
does **not** pin a pnpm version - `pnpm/action-setup` reads `packageManager` from
`package.json`, so bump that field rather than the workflow. `codeql.yml` scans
`actions,javascript-typescript`.
