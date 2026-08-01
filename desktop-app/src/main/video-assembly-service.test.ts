import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { EditProject } from "../shared/edit";
import { DEFAULT_VIDEO_ASSEMBLY_SETTINGS } from "../shared/video-assembly";
import { VideoAssemblyService } from "./video-assembly-service";

const execFileAsync = promisify(execFile);

function project(root: string, first: string, second: string, audio: string): EditProject {
  const clip = (number: number, sourcePath: string, startMs: number) => ({
    id: `clip-${number}`, kind: "video" as const, sourcePath, label: `Scene ${number}`, startMs, durationMs: 1_000,
    sourceDurationMs: 1_000, trimInMs: 0, trimOutMs: 1_000, sceneId: `scene-${number}`, sceneNumber: number,
    chainRole: number === 1 ? "start" as const : "continue" as const, muted: false, volume: 100, visible: true, locked: false, warnings: [],
  });
  return { id: "edit-test", sessionId: "assembly-test", name: "Assembly test", width: 1920, height: 1080, fps: 60, durationMs: 2_000, clips: [clip(2, second, 1_000), clip(1, first, 0)], audioPath: audio, subtitlePath: "", backgroundMusicPath: "", updatedAt: new Date().toISOString(), savedAt: new Date().toISOString(), status: "ready" };
}

test("validates and sorts scene media before building a safe FFmpeg graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-assembly-"));
  const first = join(root, "scene 001.mp4");
  const second = join(root, "scene 002.mp4");
  const voice = join(root, "voice.wav");
  try {
    await mkdir(root, { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", first], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", second], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "2", "-c:a", "pcm_s16le", voice], { windowsHide: true });
    const service = new VideoAssemblyService(root);
    const current = project(root, first, second, voice);
    assert.deepEqual(service.sortClips(current).map((clip) => clip.sceneNumber), [1, 2]);
    const validation = await service.validate(current, { ...DEFAULT_VIDEO_ASSEMBLY_SETTINGS, sourceVideoVolume: 35 });
    assert.equal(validation.valid, true);
    assert.equal(validation.scenes.length, 2);
    assert.equal(validation.totalDurationSeconds, 2);
    const args = service.buildFfmpegArguments(current, DEFAULT_VIDEO_ASSEMBLY_SETTINGS, validation.scenes.flatMap((scene) => scene.media ? [{ clip: service.sortClips(current).find((clip) => (clip.sceneId || clip.id) === scene.sceneId)!, media: scene.media, expectedDurationSeconds: scene.expectedDurationSeconds }] : []), join(root, "out.mp4"), validation.outputDurationSeconds);
    assert.ok(args.includes("-filter_complex"));
    assert.ok(args.includes("-progress"));
    assert.ok(args.includes("+faststart"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates source-audio-only assembly without a voice track", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-assembly-source-audio-"));
  const first = join(root, "scene-001.mp4");
  const second = join(root, "scene-002.mp4");
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", first], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", second], { windowsHide: true });
    const service = new VideoAssemblyService(root);
    const current = project(root, first, second, "");
    const validation = await service.validate(current, DEFAULT_VIDEO_ASSEMBLY_SETTINGS);
    assert.equal(validation.valid, true);
    assert.equal(validation.voicePath, "");
    assert.equal(validation.voiceDurationSeconds, 0);
    assert.ok(validation.warnings.some((warning) => warning.includes("audio gốc")));
    const probes = validation.scenes.flatMap((scene) => scene.media ? [{
      clip: service.sortClips(current).find((clip) => (clip.sceneId || clip.id) === scene.sceneId)!,
      media: scene.media,
      expectedDurationSeconds: scene.expectedDurationSeconds,
    }] : []);
    const args = service.buildFfmpegArguments(current, DEFAULT_VIDEO_ASSEMBLY_SETTINGS, probes, join(root, "out.mp4"), validation.outputDurationSeconds);
    const graph = args[args.indexOf("-filter_complex") + 1];
    assert.match(graph, /\[sourceMix\]alimiter=limit=0\.95\[mixed\]/);
    assert.doesNotMatch(graph, /voicea/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assembles a playable 60 FPS MP4 without modifying source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-assembly-run-"));
  const first = join(root, "scene-001.mp4");
  const voice = join(root, "voice.wav");
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", first], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "1", "-c:a", "pcm_s16le", voice], { windowsHide: true });
    const before = (await stat(first)).size;
    const current = project(root, first, first, voice);
    current.clips = [current.clips[0]];
    current.durationMs = 1_000;
    const service = new VideoAssemblyService(root);
    const result = await service.start(current, { ...DEFAULT_VIDEO_ASSEMBLY_SETTINGS, fileName: "final.mp4" });
    assert.equal(result.fps, 60);
    assert.ok((await stat(result.outputPath)).isFile());
    assert.equal((await stat(first)).size, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
