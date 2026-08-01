# Vyren AI Worker Protocol

This file is the source of truth for messages exchanged between the Electron
main process and Chrome extension workers. The transport is a WebSocket bound
to localhost. All messages are JSON objects and must contain `type`.

## Connection lifecycle

- Endpoint: `ws://127.0.0.1:17890`.
- The Electron app binds only to `127.0.0.1`; the worker channel is not exposed
  to the local network.
- `REGISTER` must be the first worker message and must arrive within 5 seconds
  after the socket opens.
- The app keeps a pool of active sockets for each role. Each socket represents
  one supported browser tab and can process one active job at a time.
- A newer valid registration only replaces an older socket when the exact same
  `profileTag` registers again. The current extension appends `:tab-{tabId}` to
  the Chrome profile tag so multiple tabs in the same Chrome profile can run as
  separate worker slots.
- The app sends `PING` every 20 seconds. The worker answers with `PONG` carrying
  the same `timestamp`. A connection with no message for 45 seconds is closed.
- A disconnected worker retries with exponential backoff capped at 15 seconds.
  A Chrome alarm also wakes the service worker every 30 seconds to recover when
  the desktop app was unavailable.

## Roles

| Role | Responsibility |
| --- | --- |
| `chat-worker` | Operate the ChatGPT tab, generate a scene timeline, and optionally generate still images through ChatGPT Image. |
| `claude-worker` | Operate Claude for timeline generation and policy-safe prompt rewrites. |
| `gemini-worker` | Operate Gemini for timeline/policy tasks and provider image/video generation. |
| `grok-worker` | Operate Grok for timeline/policy tasks and Grok Imagine image/video generation. |
| `flow-worker` | Operate Google Flow and generate images or videos. |
| `capcut-worker` | Operate CapCut Video Studio for provider video generation. |

Only the role listed for an action may accept that action.

## Worker to app

### `REGISTER`

Sent immediately after a worker connects.

```json
{ "type": "REGISTER", "role": "gemini-worker", "provider": "gemini", "capabilities": ["GENERATE_TIMELINE", "REWRITE_POLICY_PROMPT", "GENERATE_PROVIDER_IMAGE", "GENERATE_PROVIDER_VIDEO"], "profileTag": "acc-gemini-1", "workerVersion": "2.58.0" }
```

- `role`: `chat-worker`, `claude-worker`, `gemini-worker`, `grok-worker`,
  `flow-worker`, or `capcut-worker`.
- `provider`: provider identity associated with the active supported tab.
- `capabilities`: actions this exact extension version can accept.
- `profileTag`: stable local label for the Chrome profile and tab. It must not
  contain credentials or a Google account identifier. Current tab-scoped values
  look like `profile-ab12cd34:tab-123`.
- `workerVersion`: extension manifest version used to reject stale workers for
  job actions while keeping connection diagnostics available.

### `PONG`

Response to `PING`.

```json
{ "type": "PONG", "timestamp": 1784000000000 }
```

`timestamp` echoes the value received in `PING`.

### `JOB_PROGRESS`

```json
{
  "type": "JOB_PROGRESS",
  "jobId": "scene-003-image",
  "status": "generating",
  "message": "Waiting for Google Flow",
  "heartbeat": true
}
```

- `status`: `queued`, `preparing`, `generating`, `downloading`, or `stopping`.
- `message`: optional human-readable detail.
- `heartbeat`: the extension sends a progress heartbeat every 5 seconds while an
  AI job is active. The desktop queue persists it and treats a silent job as
  stuck, then stops and retries it according to queue policy.

### `JOB_DONE`

Scene media jobs return a structured result:

```json
{
  "type": "JOB_DONE",
  "jobId": "scene-003-image",
  "result": {
    "sceneId": "scene-003",
    "mediaType": "image",
    "resultPath": "C:/Users/user/Vyren AI/scene_003.png"
  }
}
```

Timeline jobs return structured `result`:

```json
{
  "type": "JOB_DONE",
  "jobId": "timeline-001",
  "result": { "scenes": [] }
}
```

`result` is required and is validated against the original job payload.

### `JOB_ERROR`

```json
{
  "type": "JOB_ERROR",
  "jobId": "scene-003-image",
  "error": "Timed out while waiting for an image",
  "code": "TIMEOUT",
  "retryable": true
}
```

- `code`: `INVALID_JOB`, `WRONG_ROLE`, `NOT_LOGGED_IN`, `QUOTA_EXCEEDED`,
  `TIMEOUT`, `STOPPED`, `DOWNLOAD_FAILED`, or `INTERNAL_ERROR`.
- `retryable`: whether retrying the same job may succeed without user action.

## App to worker

### `PING`

```json
{ "type": "PING", "timestamp": 1784000000000 }
```

### `JOB`

```json
{
  "type": "JOB",
  "jobId": "scene-003-image",
  "action": "GENERATE_IMAGE",
  "payload": {}
}
```

`jobId` is unique for the lifetime of the desktop app. A worker processes one
job at a time and must answer with one terminal `JOB_DONE` or `JOB_ERROR`.

### `STOP`

Stops the active job. Omitting `jobId` stops whichever job is active.

```json
{ "type": "STOP", "jobId": "scene-003-image" }
```

The worker reports `JOB_ERROR` with code `STOPPED` after cleanup.

## Job actions

### `GENERATE_TIMELINE`

Required role: the selected text worker: `chat-worker`, `claude-worker`,
`gemini-worker`, or `grok-worker`.

```json
{
  "srtText": "1\n00:00:00,000 --> 00:00:04,000\n...",
  "scriptText": "...",
  "graphicStyle": "Stickman, flat 2D illustration, white background, bold black outlines"
}
```

`graphicStyle` is optional user input. When non-empty, it overrides the style
returned by ChatGPT and is carried through the Visual Bible to every Google
Flow image prompt.

Before scene prompt batches, the ChatGPT content worker runs an internal
`beat_planning` task over the complete SRT and script. Its locked contract uses
continuous 4/6/8-second boundaries and carries `chainId` plus `chainRole`
(`single`, `start`, or `continue`) into every generated scene.

The result is:

```json
{
  "visualBible": {
    "style": "cinematic 3D animation",
    "palette": "teal shadows and warm gold accents",
    "lighting": "soft directional sunset light",
    "continuityNotes": "Keep recurring character designs and wardrobe unchanged",
    "aspectRatio": "16:9"
  },
  "scenes": [{
    "timeStart": "00:00:00,000",
    "timeEnd": "00:00:08,000",
    "durationSeconds": 8,
    "chainId": "opening-001",
    "chainRole": "start",
    "imagePrompt": "...",
    "videoPrompt": "...",
    "usedCharacterTokens": []
  }]
}
```

The first ChatGPT batch derives the Visual Bible from the complete script.
Subsequent batches reuse it and return only their scenes; the worker joins all
batches into the final result above.

### `GENERATE_IMAGE`

Required role: `flow-worker`.

```json
{
  "sceneId": "scene-003",
  "mediaType": "image",
  "prompt": "Portrait of @ANCESTOR at sunrise",
  "characterTokens": ["@ANCESTOR"],
  "visualBible": {
    "style": "cinematic 3D",
    "palette": "teal and warm gold",
    "lighting": "soft sunset",
    "continuityNotes": "Keep wardrobe unchanged",
    "aspectRatio": "16:9"
  },
  "imageSettings": {
    "provider": "google-flow",
    "model": "nano-banana-pro",
    "aspectRatio": "16:9",
    "outputCount": 1,
    "expectedCredits": 0
  },
  "refImages": [
    {
      "token": "@ANCESTOR",
      "name": "The Ancestor",
      "mimeType": "image/png",
      "imageBase64": "iVBORw0KGgo...",
      "localPath": "C:/Users/user/Vyren AI/characters/ancestor.png"
    }
  ]
}
```

The desktop resolves the explicit `characterTokens` assignment against the
Phase 2 character library and attaches each selected image exactly once. Prompt
parsing is not used as the source of truth. An unknown assigned token rejects
the job before it reaches the worker. The Flow worker requires the Nano Banana
Pro option to show zero credits, uploads and verifies these references, compiles
the Visual Bible with the scene prompt, creates the image, downloads it to
`Downloads/Vyren AI`, and returns the absolute path.

### `GENERATE_CHATGPT_IMAGE`

Required role: `chat-worker`.

The payload shape matches `GENERATE_IMAGE`, but `imageSettings.provider` is
`chatgpt-image` and `imageSettings.model` is `chatgpt-web`. The ChatGPT worker
attaches the scene references to the composer, sends the Visual Bible plus the
scene prompt, waits for a newly generated assistant image, downloads it to
`Downloads/Vyren AI`, and returns the absolute path.

### `GENERATE_PROVIDER_IMAGE`

Required role: `gemini-worker` for `gemini-image`, or `grok-worker` for
`grok-image`.

The payload shape matches `GENERATE_IMAGE`. The selected provider must agree
with the registered worker role. The adapter opens the provider media surface,
attaches all explicit scene references, submits the Visual Bible plus scene
prompt, detects a newly generated image, downloads it, and returns its absolute
path.

### `GENERATE_PROVIDER_VIDEO`

Required role: `gemini-worker` for `gemini-video`, `grok-worker` for
`grok-video`, or `capcut-worker` for `capcut-video`.

The video payload includes the selected `videoSettings` plus `sourceImage`, a
validated PNG/JPEG/WebP reference containing `mimeType`, `imageBase64`, and
`localPath`. The adapter selects video mode, attaches that image as the opening
frame when the mode is image-first, submits the motion prompt and duration,
waits for a newly generated video, then invokes the provider's native download
control. The desktop queue
keeps the same sequential continue-scene and extracted-final-frame rules used
by Google Flow.

### `GENERATE_VIDEO`

Required role: `flow-worker`.

```json
{
  "sceneId": "scene-003",
  "mediaType": "video",
  "prompt": "Slow camera movement"
}
```

Google Flow videos support image-first and direct text-to-video modes. In
`submit-only` delivery the worker submits the prompt and returns a submitted
state without waiting for render/download; in `download` delivery it waits for
the native downloaded file and returns its absolute path.

## Scene shape

```json
{
  "id": "scene-003",
  "order": 3,
  "timeStart": "00:00:08,000",
  "timeEnd": "00:00:08,000",
  "imagePrompt": "...",
  "imageStatus": "pending",
  "imageResultPath": "",
  "videoPrompt": "...",
  "videoStatus": "pending",
  "videoResultPath": "",
  "usedCharacterTokens": ["@ANCESTOR"],
  "characterPolicy": "selected",
  "assignedCharacterTokens": ["@ANCESTOR"]
}
```

Image and video statuses are `pending`, `generating`, `done`, or `error`.
