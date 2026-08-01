import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { TimelineSession } from "../shared/timeline";
import { EditService } from "./edit-service";

const execFileAsync = promisify(execFile);

test("creates and persists a real 1080p 60 FPS edit manifest from session outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-edit-"));
  const sessionRoot = join(root, "session-edit");
  await mkdir(join(sessionRoot, "audio"), { recursive: true });
  await mkdir(join(sessionRoot, "srt"), { recursive: true });
  const firstVideo = join(sessionRoot, "scene-001.mp4");
  const secondVideo = join(sessionRoot, "scene-002.mp4");
  const audioPath = join(sessionRoot, "audio", "voice.wav");
  const srtPath = join(sessionRoot, "srt", "voice.srt");
  await Promise.all([
    writeFile(firstVideo, "video-one"), writeFile(secondVideo, "video-two"),
    writeFile(audioPath, "audio"), writeFile(srtPath, "1\n00:00:00,000 --> 00:00:08,000\nHello"),
  ]);
  const scene = (order: number, path: string) => ({
    id: `scene-${String(order).padStart(3, "0")}`, order,
    timeStart: order === 1 ? "00:00:00,000" : "00:00:08,000",
    timeEnd: order === 1 ? "00:00:08,000" : "00:00:14,000",
    durationSeconds: order === 1 ? 8 as const : 6 as const,
    chainId: "chain-edit", chainRole: order === 1 ? "start" as const : "continue" as const,
    imagePrompt: order === 1 ? "image" : "", imageStatus: "done" as const,
    imageResultPath: "", imageFlowAssetKey: "", imageApproved: true,
    videoPrompt: "video", videoStatus: "done" as const, videoResultPath: path, videoApproved: true,
    usedCharacterTokens: [], characterPolicy: "none" as const, assignedCharacterTokens: [],
  });
  const session: TimelineSession = {
    id: "session-edit", name: "Edit Test", createdAt: new Date().toISOString(), savedAt: new Date().toISOString(),
    scenes: [scene(1, firstVideo), scene(2, secondVideo)],
    visualBible: { style: "style", palette: "palette", lighting: "light", continuityNotes: "notes", aspectRatio: "16:9" },
    styleReference: null, workflowMode: "automatic",
    workflowSource: { narrationText: "", narrationFileName: "", narrationPath: "", srtText: "", scriptText: "", srtFileName: "", scriptFileName: "", srtPath, scriptPath: "", audioPath, audioFileName: "voice.wav", voiceName: "Voice", voiceRate: 0, voicePitch: 0, voiceVolume: 0, voicePauseLevel: "off" },
  };
  try {
    const service = new EditService(root);
    const project = await service.sync(session);
    assert.equal(project.width, 1920);
    assert.equal(project.height, 1080);
    assert.equal(project.fps, 60);
    assert.equal(project.durationMs, 14_000);
    assert.equal(project.clips.length, 2);
    assert.equal(project.audioPath, audioPath);
    assert.equal(project.subtitlePath, srtPath);
    assert.equal((await service.load(session)).clips.length, 2);
    const imported = await service.importVideo(session.id, firstVideo);
    assert.match(imported, /[\\/]edit[\\/]imports[\\/]/);
    assert.ok((await stat(imported)).isFile());
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", firstVideo], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "2", "-c:a", "pcm_s16le", audioPath], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-i", firstVideo, "-c", "copy", secondVideo], { windowsHide: true });
    const realProject = await service.sync(session);
    const exported = await service.export(realProject, { includeSubtitles: false, includeMusic: false, quality: "standard", fileName: "test-60fps.mp4" });
    assert.equal(exported.fps, 60);
    assert.ok((await stat(exported.outputPath)).isFile());
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,width,height", "-of", "json", exported.outputPath], { windowsHide: true });
    const probe = JSON.parse(stdout) as { streams?: Array<{ r_frame_rate?: string; width?: number; height?: number }> };
    assert.equal(probe.streams?.[0]?.r_frame_rate, "60/1");
    assert.equal(probe.streams?.[0]?.width, 1920);
    assert.equal(probe.streams?.[0]?.height, 1080);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reloads a stale empty edit manifest from the current session outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-edit-reload-"));
  const sessionRoot = join(root, "session-reload");
  const videoPath = join(sessionRoot, "scene-001.mp4");
  const audioPath = join(sessionRoot, "voice.wav");
  await mkdir(join(sessionRoot, "edit"), { recursive: true });
  await writeFile(videoPath, "placeholder");
  await writeFile(audioPath, "placeholder");
  const session = {
    id: "session-reload", name: "Reload", createdAt: new Date().toISOString(), savedAt: new Date().toISOString(),
    scenes: [{ id: "scene-001", order: 1, timeStart: "00:00:00,000", timeEnd: "00:00:04,000", durationSeconds: 4 as const, imagePrompt: "", imageStatus: "done" as const, imageResultPath: "", imageFlowAssetKey: "", imageApproved: true, videoPrompt: "", videoStatus: "done" as const, videoResultPath: videoPath, videoApproved: true, usedCharacterTokens: [], characterPolicy: "none" as const, assignedCharacterTokens: [], chainId: null, chainRole: "single" as const }],
    visualBible: { style: "", palette: "", lighting: "", continuityNotes: "", aspectRatio: "16:9" as const }, styleReference: null, workflowMode: "automatic" as const,
    workflowSource: { narrationText: "", narrationFileName: "", narrationPath: "", srtText: "", scriptText: "", srtFileName: "", scriptFileName: "", srtPath: "", scriptPath: "", audioPath, audioFileName: "voice.wav", voiceName: "", voiceRate: 0, voicePitch: 0, voiceVolume: 0, voicePauseLevel: "off" as const },
  } as TimelineSession;
  try {
    await writeFile(join(sessionRoot, "edit", "edit-project.json"), JSON.stringify({ id: "edit-session-reload", sessionId: session.id, name: "Reload · Edit", width: 1920, height: 1080, fps: 60, durationMs: 0, clips: [], audioPath: "", subtitlePath: "", backgroundMusicPath: "", updatedAt: new Date().toISOString(), savedAt: new Date().toISOString(), status: "draft" }));
    const project = await new EditService(root).load(session);
    assert.equal(project.clips.length, 1);
    assert.equal(project.audioPath, audioPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
