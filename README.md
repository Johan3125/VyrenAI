# Vyren AI

Vyren AI by Vyren AI Worker separates workflow orchestration from browser automation:

- `desktop-app/`: Electron main process and React renderer.
- `extension-worker/`: one Manifest V3 extension installed in both Chrome profiles.
- `vyren-ai-flow/`: standalone Google Flow bulk-image extension, separate from the main worker.
- `PROTOCOL.md`: the message contract shared by the desktop app and extension.

Use `extension-worker/` for the desktop app. Use `vyren-ai-flow/` only as a standalone Google Flow batch tool, preferably in a separate Chrome profile or with the main worker disabled for that Flow tab.

## Desktop app

```powershell
cd desktop-app
npm install
npm run dev
```

`npm run dev` starts the Vite renderer and opens the Electron window.

## Storage location

Vyren AI now uses one centralized storage layout. On Windows, when drive
`D:` exists, the default is:

```text
D:\Vyren AI\
  Data\
  Outputs\
  Backups\
```

On first launch, the app copies and verifies the former business data under
Electron `userData` and `Downloads/Vyren AI`, rebases saved JSON/SQLite
asset paths, and only then removes the migrated legacy folders. Electron cache
and UI local preferences remain in the normal Windows application-data folder.
Use `VYREN_AI_STORAGE_ROOT` to override the centralized root. Test and smoke
scripts may continue to use `FLOWX_DATA_DIR` for an isolated data root.

## Integrated Voice → SRT → Video workflow

The desktop home screen offers three entry points:

- **Tạo tự động toàn bộ video**: required narration text, optional visual
  script, voice/prosody settings and Visual Bible are collected once. The app
  generates voice plus SRT, sends the generated SRT and effective script to the
  ChatGPT timeline worker, then starts the approved image/video production
  queue. Images can be routed to Google Flow, ChatGPT Image, Gemini Image, or
  Grok Image. Videos can be routed to Google Flow, Gemini Video, Grok Video, or
  CapCut Video Studio.
- **Tạo từ file SRT và kịch bản**: opens a clean workspace and uses the existing
  Phase 3 timeline importer without synthesizing voice.
- **Tạo từng bước**: generates and saves voice/SRT first, then waits for the
  operator before opening timeline/prompt review and production.

If no optional visual script is supplied, narration text is reused as the
script input. Outputs are isolated under
`Downloads/Vyren AI/<workspace-id>/`; voice lives in `audio/`, subtitles in
`srt/`, and both use unique file names to avoid Windows `EBUSY` replacement
errors. The Output screen can also export `metadata/project.json`,
`visual-bible/visual-bible.json`, and `prompts/scenes.json` without moving the
existing image, video, or final-frame files.

## Desktop workspace UI

The React renderer uses a dark Vyren AI desktop shell with persistent page,
sidebar, queue-drawer, session, and selected-scene state. It reuses the existing
LowDB timeline session store, SQLite production queue, IPC handlers, and local
WebSocket workers. The right Production Queue remains sequential; continue
scenes still wait for the previous extracted final frame. Deleting generated
results keeps the Phase 3 timeline and prompts.

Voice synthesis uses `edge-tts-universal` and the unofficial Microsoft Edge
online TTS endpoint. It requires network access and has no service SLA. The
dependency is AGPL-3.0 licensed, so review its redistribution obligations before
shipping Vyren AI outside personal/internal use. FFmpeg and FFprobe must be
available on `PATH`; they are used to join long narration chunks, insert real
punctuation-aware silence, and keep SRT timing aligned with the final audio.

Voice Studio also supports an existing `.mp3` narration source. In this mode
Vyren AI verifies the real MP3 stream with FFprobe, copies the source into the
session output, bypasses voice selection and Edge TTS, and uses the imported
audio unchanged for the final edit. A timestamped `.srt` is required so scene
planning remains synchronized; a same-name sidecar SRT is imported
automatically, or the operator can select one separately. The importer rejects
an SRT that extends more than two seconds beyond the audio and surfaces
low-bitrate, low-sample-rate, overlap, or early-ending warnings.

## Extension worker

1. Open `chrome://extensions` in each Chrome profile.
2. Enable Developer mode.
3. Select **Load unpacked** and choose `extension-worker/`.
4. Confirm that `Vyren AI Worker` loads without errors.

## Phase 1 connection check

1. Start the desktop app first.
2. Open and sign in to the text-provider page selected in Settings.
3. Open the selected media pages: Google Flow under `https://labs.google/fx/`,
   Gemini under `https://gemini.google.com/`, Grok Imagine under
   `https://grok.com/imagine`, or CapCut Video Studio under
   `https://www.capcut.com/ai-creator/start`.
4. Reload the unpacked extension after pulling code changes. The current
   worker manifest is `2.64.0`.
5. The extension badge changes to `ON` for each supported tab.
6. The desktop app shows separate connected states for the selected text,
   image, and video workers. One connected Gemini or Grok worker can satisfy
   both image and video when both media providers use that same service.

The desktop app listens only on `ws://127.0.0.1:17890`. Each Chrome profile
gets a random local `profileTag`; no Google account identifier is read or sent.
The extension appends `:tab-{tabId}` when registering a supported tab, so one
Chrome profile can expose multiple worker slots when multiple supported tabs
are open. Each tab still processes one active job at a time.

Run the server heartbeat smoke test while the desktop app is open:

```powershell
cd desktop-app
npm run smoke:workers
npm run smoke:reconnect
```

## Phase 2 character library

Open the **Nhân vật** tab to create, edit, or delete character references.

- Tokens are normalized to uppercase and stored with the `@` prefix.
- Tokens may contain letters, numbers, and underscores.
- Reference images accept PNG, JPEG, or WebP up to 10 MB.
- Character metadata is stored in `character-library/characters.json` under
  Electron's user data directory.
- Managed image copies are stored in `character-library/images/`.

The reusable `parseCharacterTokens()` helper extracts unique prompt tokens in
their original order. Run Phase 2 tests with the desktop app closed:

```powershell
cd desktop-app
npm test
npm run smoke:characters
```

## Phase 3 timeline import

Open the **Timeline** tab, select one `.srt` subtitle file and one `.txt` or
`.md` script file, then generate through the connected ChatGPT worker. Each
file is limited to 2 MB. The worker asks ChatGPT for structured JSON and the
desktop app validates and normalizes it before rendering the scene table.
The first batch analyzes the complete script and returns a project-wide Visual
Bible (`style`, `palette`, `lighting`, continuity rules, and aspect ratio).
The desktop fills the Visual Bible panel automatically, and all later batches
must preserve it while writing their image and video prompts.
The always-visible **Phong cách đồ họa** input can lock a user-provided style
before timeline generation or override it afterward. The same value is sent in
the timeline request, stored in the Visual Bible, previewed in the image modal,
and prepended to every Google Flow image prompt.
Projects are locked to 16:9 and are designed for 10-15 minute source timelines.
Character tokens are optional: the worker preserves a token only when the
source mentions that character and the scene visibly uses them; otherwise the
scene carries no character reference.
Phase 3a first sends the complete SRT and script as a `beat_planning` task. It
locks a continuous, gap-free boundary contract using 4, 6, or 8-second scenes
and marks each scene as `single`, `start`, or `continue` in a chain. Prompt
generation then runs sequentially in batches of up to 6 scenes without allowing
ChatGPT to change those boundaries. Invalid beat plans or scene JSON are retried
twice. The Phase 4 table exposes editable **Chain** and **Thời lượng** columns;
manual changes are saved with the timeline and synchronized to SQLite.
Keep the ChatGPT tab visible while timeline generation is running. This stable
rollback intentionally does not automate hidden or background-tab lifecycle.
If the extension was reloaded after ChatGPT opened, the worker reinjects the
content script into the verified main frame and retries dispatch once.

Reload `extension-worker/` from `chrome://extensions` after updating Phase 3.
Run the deterministic desktop-to-worker smoke test (it uses an isolated test
port, so the development app may remain open):

```powershell
cd desktop-app
npm run build
npm run smoke:timeline
```

## Phase 4 scene management

Generated scenes are persisted in renderer storage and displayed in an editable
management table. Image and video prompts can be edited inline, rerun, or
replaced through the alternate-prompt editor. Per-scene progress and completion
arrive through the desktop-to-Flow-Worker WebSocket job protocol and update only
the matching row.

Phase 4 intentionally uses a short mock media executor in `background.js`.
It exercises `GENERATE_IMAGE` and `GENERATE_VIDEO` end to end without operating
Google Flow; Phase 5 and Phase 6 replace those mock actions with real generation.

Reload `extension-worker/` in both Chrome profiles to version `2.11.0`, then run:

```powershell
cd desktop-app
npm test
npm run smoke:scenes
```

## Phase 5 Google Flow image generation

Phase 5.1 stores a project Visual Bible and explicit character assignments for
each scene. The image modal previews the selected Phase 2 references and locks
the Ultra preset to Nano Banana Pro, one output, and an expected cost of zero
credits. Character binding no longer depends on tokens appearing in prompt
text. The worker verifies the free model option, uploads every selected
reference, confirms each prompt thumbnail, and only then submits the compiled
Visual Bible plus scene prompt. Results are saved under Chrome's
`Downloads/Vyren AI` directory and restored from the saved session.

Vyren AI also supports ChatGPT Image as an alternate image provider. The
workflow and Production Queue controls expose Flow, ChatGPT, Gemini, and Grok
for image jobs, plus Flow, Gemini, and Grok for video jobs. When ChatGPT Image
is selected, still-image jobs are routed to the
`chat-worker` with `GENERATE_CHATGPT_IMAGE`; the worker attaches scene
references in ChatGPT, waits for the generated image, and saves it for the
selected video-provider step. Gemini/Grok jobs use
`GENERATE_PROVIDER_IMAGE`/`GENERATE_PROVIDER_VIDEO` and preserve the same
source-frame continuity contract as Flow.

Reload `extension-worker/` to version `2.58.0` and refresh the open provider
tabs before testing.

```powershell
cd desktop-app
npm test
npm run smoke:phase5
```

## Phase 7 production queue

The Phase 4 table now has a crash-safe SQLite production queue. It can generate
all pending images, generate videos only from approved images, pause, resume,
stop, retry failed scenes, resume from a selected row, or regenerate exactly
one scene. Right-click a scene row for the resume/regenerate commands.

Jobs run sequentially through the selected image worker and the Flow video
worker, respect `depends_on`, and retry retryable failures with 2s/8s/20s
backoff (three attempts by default). The
Error Center groups DOM, response, timeout, quota, and extension-connection
failures. Extension version `2.40.0` starts looking immediately after video submit for the in-progress `a > div` card containing `play_circle` plus any numeric percentage, locks its anchor as soon as it appears, and clicks that render result every two seconds until its viewer opens. After another five seconds it retries native `Tải xuống` every two seconds until Chrome creates the download, waits for the file, and clicks `Xong`. Direct signed HTTPS and blob conversion remain fallbacks. It retains single-popup `VIDEO_FRAMES` / `VIDEO_REFERENCES` configuration, clean-composer handling, duration-aware pacing, bounded continuation references, and Start-frame-only video generation; reload
the unpacked extension before using the production queue.

Extension version `2.41.0` prevents duplicate native video files by polling only the disabled state of the viewer's download button. It clicks the button exactly once when enabled, waits for Chrome to register and finish that same download, and only then closes the viewer.

Extension version `2.42.0` uses only the native Google Flow download for video. Once that route begins, Vyren AI Worker observes and renames the same Chrome download but never starts the former direct-URL fallback, preventing one Flow transfer plus one app transfer for the same scene.
Vyren AI also refuses to dispatch video jobs to Vyren AI Worker older than `2.42.0`, rejects an older duplicate worker when a newer profile is connected, and sends `STOP` before replacing a worker from the same profile.

Continuation scenes now skip separate still-image generation. After a chain's previous video is downloaded, FFmpeg samples its final image at 0.05 seconds from the end into `.kc-frames`; that exact PNG becomes the next scene's approved opening image and Flow Start frame. The next video prompt animates forward from it without an End frame, reducing one Flow image generation per continuation and preserving pixel-exact boundary continuity.
Phase 3 timeline generation now requires Vyren AI Worker `2.44.0` or newer so an older ChatGPT worker cannot silently replace Beat & Chain Planning, keep generating image prompts for continuation scenes, or omit the style-reference analysis.

Extension version `2.43.0` stops writing image prompts for `continue` scenes. Phase 3 returns an empty `imagePrompt` for those boundaries, while Production Queue extracts the preceding downloaded video's frame at `-0.05s`, uses it immediately as Flow's Start frame, and submits only the continuation video prompt. `single` and `start` scenes still generate their own opening image normally.

Extension version `2.44.0` adds an optional graphic-style reference image. Vyren AI persists the selected PNG/JPEG/WebP with the workspace and attaches it to the first Phase 3a ChatGPT message. ChatGPT retains a visual analysis across later batches and appends it to the user-entered base style; the desktop server preserves the complete user base before accepting that expansion. Timeline storage version 3 also supports multiple named workspaces with isolated SQLite project IDs, create/switch/rename/delete controls, confirmation before deletion, and automatic migration of the former single session.

Extension version `2.45.0` isolates generated image and video downloads in a stable folder for each workspace under `Downloads/Vyren AI/session-<workspace-id>`. Queue snapshots are also rejected unless they belong to the workspace currently open in the renderer, preventing old `scene-001` results from appearing in a newly created workspace. Clearing generated results now protects paths shared by migrated workspaces and retries Windows `EBUSY`/permission locks before reporting which file is still open in Chrome or Flow.

Extension version `2.46.0` captures newly appearing Google Flow render errors from visible alert/span content before image or video timeouts. Policy failures are stored verbatim in the production Error Center. The desktop policy-repair action now opens a reason picker based on Google's published prohibited-use categories, pre-fills the captured Flow message, accepts operator detail, then stops the queue, asks ChatGPT for a policy-safe rewrite, and resumes from that scene.

Extension version `2.47.0` removes a slow-machine race in character-assisted image generation. Attaching a character now requires a stable prompt ingredient thumbnail for three consecutive DOM polls and retries the picker sequence twice. Prompt submission is split into type, verify, and submit checkpoints: the worker must read back the expected prompt from Flow for three consecutive polls before it is allowed to press Enter, and an empty editor is no longer accepted as proof of submission unless a verified prompt existed immediately beforehand.

Extension version `2.48.0` treats the `cancel` material-symbol overlay on a prompt attachment as authoritative evidence that Google Flow accepted a character image. The worker no longer uploads the same character repeatedly when Flow represents the ingredient without a detectable `img`; after this marker appears, character-assisted image jobs paste and submit immediately. Non-character jobs keep the existing prompt read-back checkpoint.

Extension version `2.49.0` locks duration selection to an exact Radix duration tab: stable `trigger-N`/`content-N` identity plus the visible `Ns` label. This specifically prevents a requested 4-second clip from clicking Flow's unrelated `x4` output-count control.

Extension version `2.55.0` adds ChatGPT Image generation for scene stills. The
desktop queue stores the selected image provider per project and dispatches
Google Flow image jobs to `flow-worker` or ChatGPT Image jobs to `chat-worker`.
The payload hash includes the provider so switching providers rebuilds the
right image jobs instead of reusing stale queue entries.

Extension version `2.64.0` registers each supported browser tab as its own
worker slot using a tab-scoped `profileTag`. This allows multiple tabs in one
Chrome profile to serve concurrent jobs when the desktop queue has matching
work available. It also adds `capcut-worker` for CapCut Video Studio video
generation.

Vyren AI now also provides a trash action on every timeline row. It stops production safely and deletes only that scene's downloaded image, video, extracted frame, and related queue jobs while preserving its Phase 3 prompts, character assignment, the other scene results, and all media stored in Google Flow.

Regenerate now performs replacement instead of layering a new result over stale files. Rebuilding an image removes that scene's old image and video; rebuilding a video removes its old clip. If the changed clip leads into one or more `continue` scenes, Vyren AI invalidates their old extracted frames and videos, then runs the isolated chain `new upstream video -> new final-frame extraction -> rebuilt continuation video` without waking unrelated stopped jobs.

Extension version `2.32.0` also adds **Sửa chính sách** beside a failed image or video prompt. The action stops both direct Flow work and the production queue, asks ChatGPT for one policy-safe replacement without evasion, validates and saves it, resets the failed scene, then resumes production from that exact prompt. If rewriting or validation fails, the original prompt remains and the queue stays stopped.

When the app restarts, orphaned `running` jobs are returned to `queued` without
creating duplicates. Completed and approved scenes are left untouched.

Use **Xóa kết quả** in the production queue to return to the Phase 3 output.
After one irreversible confirmation, the app stops the queue, removes generated
images, videos, extracted frames, orphaned older copies, and all production jobs
from `Downloads/Vyren AI`. Timeline boundaries, image/video prompts, the
Visual Bible, character assignments, character library, and style presets are
preserved.
