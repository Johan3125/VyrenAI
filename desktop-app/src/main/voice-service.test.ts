import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  analyzeImportedSrt,
  buildVoiceSrt,
  buildWordVoiceSrt,
  VoiceService,
} from "./voice-service";

const execFileAsync = promisify(execFile);

test("builds continuous SRT cues from Edge TTS word timing", () => {
  const srt = buildVoiceSrt([
    { text: "Xin", start: 0, end: 0.2 },
    { text: "chào.", start: 0.21, end: 0.6 },
    { text: "Cảnh", start: 0.95, end: 1.2 },
    { text: "tiếp", start: 1.21, end: 1.45 },
  ]);
  assert.match(srt, /00:00:00,000 --> 00:00:00,600/);
  assert.match(srt, /Xin chào\./);
  assert.match(srt, /00:00:00,950 --> 00:00:01,450/);
  assert.match(srt, /Cảnh tiếp/);
});

test("exports one continuous SRT cue per synthesized word", () => {
  const srt = buildWordVoiceSrt([
    { text: "Xin", start: 0, end: 0.2 },
    { text: "chào", start: 0.21, end: 0.6 },
  ]);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:00,200\nXin/);
  assert.match(srt, /2\n00:00:00,210 --> 00:00:00,600\nchào/);
});

test("validates imported SRT timing and extracts a clean transcript", () => {
  const result = analyzeImportedSrt(`1
00:00:00,000 --> 00:00:01,000
<i>Xin chào.</i>

2
00:00:01,200 --> 00:00:02,400
Đây là voice có sẵn.
`, 3);
  assert.equal(result.cueCount, 2);
  assert.equal(result.durationSeconds, 2.4);
  assert.equal(result.transcript, "Xin chào. Đây là voice có sẵn.");
  assert.equal(result.warnings.length, 0);

  assert.throws(
    () => analyzeImportedSrt(`1
00:00:00,000 --> 00:00:08,500
Không đồng bộ.
`, 5),
    /dài hơn audio/i,
  );
});

test("exposes CapCut Web voice provider but fails fast until automation exists", async () => {
  const service = new VoiceService(join(tmpdir(), "vyren-capcut-voice-provider-test"), () => {});
  const voices = await service.listVoices("capcut-web");
  assert.equal(voices.length, 1);
  assert.equal(voices[0].provider, "capcut-web");
  assert.equal(voices[0].shortName, "capcut-web-default");

  await assert.rejects(
    () => service.preview("capcut-web-default", "vi-VN", "capcut-web"),
    /Preview in app is only available/i,
  );
  await assert.rejects(
    () => service.generate({
      provider: "capcut-web",
      projectId: "capcut-voice-test",
      projectName: "CapCut Voice Test",
      narrationText: "Hello from CapCut Voice Web.",
      narrationFileName: "narration.txt",
      voice: "capcut-web-default",
      prosody: {
        rate: 0,
        pitch: 0,
        volume: 0,
        pauseLevel: "off",
      },
    }),
    /voice automation is not available/i,
  );
});

test("imports and inspects an MP3 plus matching sidecar SRT into the session output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vyren-imported-voice-"));
  const sourceAudio = join(directory, "narration.mp3");
  const sourceSrt = join(directory, "narration.srt");
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:a", "libmp3lame", "-q:a", "4", sourceAudio,
    ], { windowsHide: true });
    await writeFile(sourceSrt, `1
00:00:00,000 --> 00:00:00,800
Voice audio nhập sẵn.
`, "utf8");
    const service = new VoiceService(join(directory, "outputs"), () => {});
    const result = await service.importAudio("session-import-test", sourceAudio);
    assert.equal(result.codec, "mp3");
    assert.ok(result.durationSeconds > 0.9);
    assert.ok(result.sizeBytes > 0);
    assert.match(result.audioPath, /session-import-test[\\/]audio/);
    assert.equal(result.subtitles?.cueCount, 1);
    assert.equal(result.subtitles?.transcript, "Voice audio nhập sẵn.");
    assert.match(result.subtitles?.srtPath || "", /session-import-test[\\/]srt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
