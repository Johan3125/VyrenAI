import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CapCutAudioMode,
  CapCutBuildInspection,
  CapCutBuildOptions,
  CapCutBuildResult,
} from "../shared/capcut";
import type { Scene, TimelineSession } from "../shared/timeline";

type JsonObject = Record<string, any>;

interface CapCutProject {
  name: string;
  folderName: string;
  directory: string;
  contentPath: string;
  timelineContentPath?: string;
  timelineCachePath?: string;
  modifiedMs: number;
  draft: JsonObject;
}

interface BuildPlan {
  inspection: CapCutBuildInspection;
  scenes: Scene[];
  target: CapCutProject | null;
  donor: CapCutProject | null;
}

const execFileAsync = promisify(execFile);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizePath(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").toLocaleLowerCase("en-US");
}

function uuid(): string {
  return randomUUID().toUpperCase();
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
}

function refreshNestedIds(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(refreshNestedIds);
    return;
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if ((key === "id" || key.endsWith("_id")) && isUuid(child)) {
      (value as JsonObject)[key] = uuid();
    } else {
      refreshNestedIds(child);
    }
  }
}

function materialGroups(draft: JsonObject): Array<[string, JsonObject[]]> {
  return Object.entries(draft.materials || {}).flatMap(([name, value]) =>
    Array.isArray(value) ? [[name, value as JsonObject[]] as [string, JsonObject[]]] : [],
  );
}

function videoTrack(draft: JsonObject): JsonObject | null {
  return (draft.tracks || []).find((track: JsonObject) => track.type === "video") || null;
}

function segmentEnd(segment: JsonObject): number {
  return Number(segment?.target_timerange?.start || 0) + Number(segment?.target_timerange?.duration || 0);
}

function projectDuration(draft: JsonObject): number {
  return Math.max(
    0,
    ...(draft.tracks || []).flatMap((track: JsonObject) =>
      (track.segments || []).map(segmentEnd),
    ),
  );
}

function timestamp(): string {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

function completedScenes(session: TimelineSession): Scene[] {
  return [...(session?.scenes || [])]
    .sort((left, right) => left.order - right.order)
    .filter((scene) => scene.videoStatus === "done" && Boolean(scene.videoResultPath));
}

function normalizeAudioMode(value: unknown): CapCutAudioMode {
  return value === "source-audio" ? "source-audio" : "target-audio";
}

export class CapCutService {
  private readonly capCutRoot: string;
  private readonly backupRoot: string;

  constructor(userDataPath: string, localAppData = process.env.LOCALAPPDATA || "") {
    this.capCutRoot = join(localAppData, "CapCut", "User Data", "Projects", "com.lveditor.draft");
    this.backupRoot = join(userDataPath, "capcut-backups");
  }

  async inspect(
    session: TimelineSession,
    targetProjectPath?: string,
    audioMode?: CapCutAudioMode,
  ): Promise<CapCutBuildInspection> {
    return (await this.createPlan(session, targetProjectPath, audioMode)).inspection;
  }

  async build(session: TimelineSession, options: CapCutBuildOptions): Promise<CapCutBuildResult> {
    if (await this.isCapCutRunning()) {
      throw new Error("Hãy đóng hoàn toàn CapCut trước khi dựng timeline để tránh project bị ghi đè.");
    }
    const plan = await this.createPlan(session, options?.targetProjectPath, options?.audioMode);
    if (!plan.inspection.ready || !plan.target || !plan.donor) {
      throw new Error(plan.inspection.reason || "Project CapCut chưa sẵn sàng.");
    }
    // The user explicitly chooses the destination. Back up the whole project
    // and replace only its video track; non-video tracks are kept untouched.
    const target = plan.target;
    const draft = clone(target.draft);
    let targetTrack = videoTrack(draft);
    const donorTrack = videoTrack(plan.donor.draft);
    const donorSegment = donorTrack?.segments?.[0] as JsonObject | undefined;
    if (!donorTrack || !donorSegment) throw new Error("Không tìm thấy cấu trúc video track CapCut hợp lệ.");
    if (!targetTrack) {
      targetTrack = clone(donorTrack);
      refreshNestedIds(targetTrack);
      targetTrack.id = uuid();
      targetTrack.segments = [];
      draft.tracks ||= [];
      draft.tracks.unshift(targetTrack);
    }

    const donorVideo = (plan.donor.draft.materials?.videos || []).find(
      (material: JsonObject) => material.id === donorSegment.material_id,
    ) as JsonObject | undefined;
    if (!donorVideo) throw new Error("Project CapCut mẫu thiếu video material.");

    const referenceTemplates = (donorSegment.extra_material_refs || []).map((referenceId: string) => {
      for (const [groupName, group] of materialGroups(plan.donor!.draft)) {
        const material = group.find((entry) => entry.id === referenceId);
        if (material) return { groupName, material };
      }
      throw new Error(`Project CapCut mẫu thiếu material ${referenceId}.`);
    });

    draft.materials ||= {};
    const previousSegments = [...(targetTrack.segments || [])];
    const removedIds = new Set<string>();
    for (const segment of previousSegments) {
      if (segment.material_id) removedIds.add(segment.material_id);
      for (const id of segment.extra_material_refs || []) removedIds.add(id);
    }
    for (const [, group] of materialGroups(draft)) {
      for (let index = group.length - 1; index >= 0; index -= 1) {
        if (removedIds.has(group[index]?.id)) group.splice(index, 1);
      }
    }

    const builtSegments: JsonObject[] = [];
    let cursor = 0;
    const keepSourceAudio = plan.inspection.audioMode === "source-audio";
    for (const scene of plan.scenes) {
      const durationMicros = scene.durationSeconds * 1_000_000;
      const materialId = uuid();
      const segment = clone(donorSegment);
      refreshNestedIds(segment);
      segment.id = uuid();
      segment.material_id = materialId;
      segment.source_timerange = { ...(segment.source_timerange || {}), start: 0, duration: durationMicros };
      segment.target_timerange = { ...(segment.target_timerange || {}), start: cursor, duration: durationMicros };
      segment.render_timerange = { ...(segment.render_timerange || {}), start: 0, duration: 0 };
      segment.speed = 1;
      segment.transition = null;
      const previousVolume = Number(segment.volume);
      const lastNonzeroVolume = Number(segment.last_nonzero_volume);
      const sourceVolume = Number.isFinite(previousVolume) && previousVolume > 0
        ? previousVolume
        : Number.isFinite(lastNonzeroVolume) && lastNonzeroVolume > 0
          ? lastNonzeroVolume
          : 1;
      segment.volume = keepSourceAudio ? sourceVolume : 0;
      segment.last_nonzero_volume = sourceVolume;

      const referenceIds: string[] = [];
      for (const template of referenceTemplates) {
        const material = clone(template.material);
        refreshNestedIds(material);
        material.id = uuid();
        referenceIds.push(material.id);
        draft.materials[template.groupName] ||= [];
        draft.materials[template.groupName].push(material);
      }
      segment.extra_material_refs = referenceIds;

      const video = clone(donorVideo);
      refreshNestedIds(video);
      video.id = materialId;
      video.local_material_id = uuid();
      video.path = scene.videoResultPath.replace(/\\/g, "/");
      video.material_name = basename(scene.videoResultPath);
      video.duration = durationMicros;
      video.width = 1280;
      video.height = 720;
      video.has_audio = true;
      draft.materials.videos ||= [];
      draft.materials.videos.push(video);

      builtSegments.push(segment);
      cursor += durationMicros;
    }

    targetTrack.segments = builtSegments;
    draft.duration = projectDuration(draft);
    const serialized = JSON.stringify(draft);
    JSON.parse(serialized);

    await mkdir(this.backupRoot, { recursive: true });
    const backupPath = join(this.backupRoot, `${target.folderName}-before-${timestamp()}`);
    await cp(target.directory, backupPath, { recursive: true, errorOnExist: true });
    await writeFile(target.contentPath, serialized, "utf8");
    if (target.timelineContentPath) await writeFile(target.timelineContentPath, serialized, "utf8");
    const rootBackupContentPath = `${target.contentPath}.bak`;
    await writeFile(rootBackupContentPath, serialized, "utf8");
    if (target.timelineContentPath) {
      const timelineBackupContentPath = `${target.timelineContentPath}.bak`;
      await writeFile(timelineBackupContentPath, serialized, "utf8");
    }
    const cachePath = join(target.directory, "template-2.tmp");
    if (await stat(cachePath).catch(() => null)) await writeFile(cachePath, serialized, "utf8");
    if (target.timelineCachePath && await stat(target.timelineCachePath).catch(() => null)) {
      await writeFile(target.timelineCachePath, serialized, "utf8");
    }

    const copiesToVerify = [
      target.contentPath,
      target.timelineContentPath,
      rootBackupContentPath,
      target.timelineContentPath ? `${target.timelineContentPath}.bak` : undefined,
    ].filter((value): value is string => Boolean(value));
    for (const contentCopyPath of copiesToVerify) {
      const verified = JSON.parse(await readFile(contentCopyPath, "utf8"));
      const verifiedTrack = videoTrack(verified);
      if (verifiedTrack?.segments?.length !== plan.scenes.length || projectDuration(verified) < cursor) {
        throw new Error(`Timeline CapCut chưa đồng bộ đủ ${plan.scenes.length} scene tại ${contentCopyPath}.`);
      }
    }

    return {
      ...plan.inspection,
      targetProjectName: target.name,
      targetProjectPath: target.directory,
      existingVideoSegments: plan.scenes.length,
      existingSessionMatch: true,
      backupPath,
      builtAt: new Date().toISOString(),
    };
  }

  private async createPlan(
    session: TimelineSession,
    targetProjectPath?: string,
    requestedAudioMode?: CapCutAudioMode,
  ): Promise<BuildPlan> {
    const audioMode = normalizeAudioMode(requestedAudioMode);
    const scenes = completedScenes(session);
    const totalScenes = session?.scenes?.length || 0;
    const videoDurationSeconds = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
    const projects = await this.readProjects();
    const availableProjects = projects.map((project) => {
      const audios = project.draft.materials?.audios || [];
      const audioDuration = audios.reduce(
        (maximum: number, audio: JsonObject) => Math.max(maximum, Number(audio.duration || 0)),
        0,
      );
      return {
        name: project.name,
        folderName: project.folderName,
        path: project.directory,
        modifiedAt: new Date(project.modifiedMs).toISOString(),
        audioCount: audios.length,
        audioDurationSeconds: audioDuration ? audioDuration / 1_000_000 : null,
        videoSegmentCount: videoTrack(project.draft)?.segments?.length || 0,
      };
    });
    const explicitTarget = targetProjectPath
      ? projects.find((project) => normalizePath(project.directory) === normalizePath(targetProjectPath)) || null
      : null;
    const target = explicitTarget ||
      (audioMode === "target-audio" ? this.findAudioProject(projects, session) : null) ||
      projects[0] ||
      null;
    const base: CapCutBuildInspection = {
      ready: false,
      reason: "",
      audioMode,
      targetProjectName: "",
      targetProjectPath: "",
      sceneCount: totalScenes,
      completedSceneCount: scenes.length,
      videoDurationSeconds,
      audioDurationSeconds: null,
      existingVideoSegments: 0,
      existingSessionMatch: false,
      selectedProjectPath: target?.directory || "",
      availableProjects,
    };
    if (!totalScenes || scenes.length !== totalScenes) {
      return {
        inspection: { ...base, reason: `Cần đủ 100% video scene (${scenes.length}/${totalScenes}) trước khi dựng.` },
        scenes,
        target: null,
        donor: null,
      };
    }
    for (const scene of scenes) {
      const info = await stat(scene.videoResultPath).catch(() => null);
      if (!info?.isFile() || info.size === 0) {
        return {
          inspection: { ...base, reason: `${scene.id} thiếu file video hợp lệ trên máy.` },
          scenes,
          target: null,
          donor: null,
        };
      }
    }
    if (!target) {
      return {
        inspection: {
          ...base,
          reason: audioMode === "source-audio"
            ? "Không tìm thấy project CapCut. Hãy tạo hoặc chọn project CapCut trống, lưu rồi đóng CapCut."
            : "Không tìm thấy project CapCut. Hãy tạo project, thêm voice, lưu rồi đóng CapCut.",
        },
        scenes,
        target: null,
        donor: null,
      };
    }
    const track = videoTrack(target.draft);
    const segments = track?.segments || [];
    const videoMap = new Map<string, JsonObject>(
      (target.draft.materials?.videos || []).map((material: JsonObject) => [material.id, material]),
    );
    const existingPaths = segments.map((segment: JsonObject) => normalizePath(videoMap.get(segment.material_id)?.path));
    const existingSessionMatch = segments.length > 0 && existingPaths.every((path: string) => path.includes(normalizePath(session.id)));
    const audioMaterial = (target.draft.materials?.audios || [])[0];
    if (!audioMaterial && audioMode === "target-audio") {
      return {
        inspection: {
          ...base,
          targetProjectName: target.name,
          targetProjectPath: target.directory,
          existingVideoSegments: segments.length,
          reason: `Project ${target.name} chưa có audio đã lưu. Hãy thêm audio, lưu project rồi đóng hoàn toàn CapCut, hoặc đổi sang chế độ dùng audio gốc clip.`,
        },
        scenes,
        target,
        donor: null,
      };
    }
    const donor = (segments.length ? target : null) || projects.find((project) => {
      const candidate = videoTrack(project.draft);
      return candidate?.segments?.length && project.draft.materials?.videos?.length;
    }) || null;
    const reason = !donor
      ? "Chưa có project CapCut mẫu chứa video để tương thích với phiên bản CapCut hiện tại."
      : audioMode === "source-audio"
        ? `Sẵn sàng dựng vào project ${target.name}. Audio gốc trong từng clip sẽ được giữ lại; project vẫn được sao lưu trước khi thay video track.`
        : `Sẵn sàng dựng vào project ${target.name}. App sẽ giữ audio project đích và sao lưu trước khi thay video track.`;
    return {
      inspection: {
        ...base,
        ready: Boolean(donor),
        reason,
        targetProjectName: target.name,
        targetProjectPath: target.directory,
        audioDurationSeconds: audioMaterial?.duration ? Number(audioMaterial.duration) / 1_000_000 : null,
        existingVideoSegments: segments.length,
        existingSessionMatch,
      },
      scenes,
      target,
      donor,
    };
  }

  private findAudioProject(projects: CapCutProject[], session: TimelineSession): CapCutProject | null {
    const expectedPath = normalizePath(session.workflowSource?.audioPath);
    const expectedName = normalizePath(session.workflowSource?.audioFileName);
    const sessionId = normalizePath(session.id);
    const ranked = projects.flatMap((project) => {
      const audios = project.draft.materials?.audios || [];
      let score = 0;
      for (const audio of audios) {
        const path = normalizePath(audio.path);
        const name = normalizePath(audio.name || audio.material_name || basename(path));
        if (expectedPath && path === expectedPath) score = Math.max(score, 100);
        else if (path.includes(sessionId)) score = Math.max(score, 80);
        else if (expectedName && name === expectedName) score = Math.max(score, 60);
      }
      return score ? [{ project, score }] : [];
    });
    return ranked.sort((left, right) => right.score - left.score || right.project.modifiedMs - left.project.modifiedMs)[0]?.project || null;
  }

  private async readProjects(): Promise<CapCutProject[]> {
    const entries = await readdir(this.capCutRoot, { withFileTypes: true }).catch(() => []);
    const projects: CapCutProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(this.capCutRoot, entry.name);
      const contentPath = join(directory, "draft_content.json");
      const info = await stat(contentPath).catch(() => null);
      if (!info?.isFile()) continue;
      try {
        let draft = JSON.parse(await readFile(contentPath, "utf8"));
        const metaPath = join(directory, "draft_meta_info.json");
        const meta = JSON.parse(await readFile(metaPath, "utf8").catch(() => "{}")) as JsonObject;
        const timelineProjectPath = join(directory, "Timelines", "project.json");
        const timelineProject = JSON.parse(await readFile(timelineProjectPath, "utf8").catch(() => "{}")) as JsonObject;
        const timelineId = String(timelineProject.main_timeline_id || timelineProject.timelines?.[0]?.id || "");
        const timelineContentPath = timelineId ? join(directory, "Timelines", timelineId, "draft_content.json") : undefined;
        const timelineCachePath = timelineId ? join(directory, "Timelines", timelineId, "template-2.tmp") : undefined;
        if (timelineContentPath && await stat(timelineContentPath).catch(() => null)) {
          draft = JSON.parse(await readFile(timelineContentPath, "utf8"));
        }
        projects.push({
          name: String(meta.draft_name || draft.name || entry.name),
          folderName: entry.name,
          directory,
          contentPath,
          timelineContentPath,
          timelineCachePath,
          modifiedMs: Math.max(info.mtimeMs, Number(meta.tm_draft_modified || 0) / 1000),
          draft,
        });
      } catch {
        // Ignore corrupted or encrypted drafts; CapCut keeps other recovery files.
      }
    }
    return projects.sort((left, right) => right.modifiedMs - left.modifiedMs);
  }

  private async isCapCutRunning(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq CapCut.exe", "/NH"], {
      windowsHide: true,
      timeout: 5_000,
    }).catch(() => ({ stdout: "" }));
    return /CapCut\.exe/i.test(stdout);
  }
}
