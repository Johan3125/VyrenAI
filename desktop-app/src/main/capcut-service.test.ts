import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TIMELINE_WORKFLOW_SOURCE,
  DEFAULT_VISUAL_BIBLE,
  type Scene,
  type TimelineSession,
} from "../shared/timeline";
import { CapCutService } from "./capcut-service";

function scene(id: string, order: number, videoResultPath: string): Scene {
  return {
    id,
    order,
    timeStart: `00:00:0${order},000`,
    timeEnd: `00:00:0${order + 4},000`,
    imagePrompt: "",
    imageStatus: "done",
    imageResultPath: "",
    imageFlowAssetKey: "",
    imageApproved: true,
    videoPrompt: "",
    videoStatus: "done",
    videoResultPath,
    videoApproved: true,
    usedCharacterTokens: [],
    characterPolicy: "none",
    assignedCharacterTokens: [],
    chainId: null,
    chainRole: "single",
    durationSeconds: 4,
  };
}

function session(videoPaths: string[]): TimelineSession {
  return {
    id: "session-asmr",
    name: "ASMR",
    createdAt: new Date(0).toISOString(),
    scenes: videoPaths.map((videoPath, index) => scene(`scene-${index + 1}`, index + 1, videoPath)),
    visualBible: DEFAULT_VISUAL_BIBLE,
    styleReference: null,
    workflowMode: "automatic",
    workflowSource: {
      ...DEFAULT_TIMELINE_WORKFLOW_SOURCE,
      sourceKind: "script",
      outputTarget: "video",
      videoSourceMode: "direct",
      audioPath: "",
      audioFileName: "",
    },
    savedAt: new Date(0).toISOString(),
  };
}

function draftWithoutAudio() {
  return {
    name: "Project 0727",
    duration: 4_000_000,
    materials: {
      audios: [],
      videos: [
        {
          id: "VIDEO-MATERIAL",
          local_material_id: "LOCAL-VIDEO-MATERIAL",
          path: "C:/template.mp4",
          material_name: "template.mp4",
          duration: 4_000_000,
          width: 1280,
          height: 720,
          has_audio: true,
        },
      ],
    },
    tracks: [
      {
        id: "VIDEO-TRACK",
        type: "video",
        segments: [
          {
            id: "VIDEO-SEGMENT",
            material_id: "VIDEO-MATERIAL",
            source_timerange: { start: 0, duration: 4_000_000 },
            target_timerange: { start: 0, duration: 4_000_000 },
            render_timerange: { start: 0, duration: 0 },
            speed: 1,
            volume: 0,
            last_nonzero_volume: 1,
            extra_material_refs: [],
          },
        ],
      },
    ],
  };
}

async function createCapCutProject(localAppData: string): Promise<string> {
  const directory = join(localAppData, "CapCut", "User Data", "Projects", "com.lveditor.draft", "project-0727");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "draft_content.json"), JSON.stringify(draftWithoutAudio()), "utf8");
  await writeFile(join(directory, "draft_meta_info.json"), JSON.stringify({ draft_name: "Project 0727" }), "utf8");
  return directory;
}

test("CapCut source-audio mode builds a project without saved audio", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyren-capcut-"));
  const localAppData = join(root, "local-app-data");
  const userData = join(root, "user-data");
  const targetProjectPath = await createCapCutProject(localAppData);
  const sceneVideoPaths = [join(root, "scene-1.mp4"), join(root, "scene-2.mp4")];
  await Promise.all(sceneVideoPaths.map((videoPath) => writeFile(videoPath, "video", "utf8")));

  const service = new CapCutService(userData, localAppData);
  (service as any).isCapCutRunning = async () => false;

  const targetAudioInspection = await service.inspect(session(sceneVideoPaths), targetProjectPath, "target-audio");
  assert.equal(targetAudioInspection.ready, false);
  assert.match(targetAudioInspection.reason, /chưa có audio đã lưu/);

  const sourceAudioInspection = await service.inspect(session(sceneVideoPaths), targetProjectPath, "source-audio");
  assert.equal(sourceAudioInspection.ready, true);
  assert.equal(sourceAudioInspection.audioMode, "source-audio");
  assert.equal(sourceAudioInspection.audioDurationSeconds, null);

  const result = await service.build(session(sceneVideoPaths), {
    replaceExisting: true,
    targetProjectPath,
    audioMode: "source-audio",
  });
  assert.equal(result.audioMode, "source-audio");

  const draft = JSON.parse(await readFile(join(targetProjectPath, "draft_content.json"), "utf8"));
  const videoTrack = draft.tracks.find((track: any) => track.type === "video");
  assert.equal(videoTrack.segments.length, 2);
  assert.equal(videoTrack.segments.every((segment: any) => segment.volume > 0), true);
});
