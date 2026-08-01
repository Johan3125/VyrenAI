import { randomUUID } from "node:crypto";
import type {
  JobRecord,
  JobState,
  ProjectCharacterRecord,
  ProjectRecord,
  ProjectSourceRecord,
  SceneRecord,
  SceneState,
  StylePresetRecord,
  VisualBibleRecord,
} from "../shared/project";
import type { ProjectDatabase } from "./project-database";

type Row = Record<string, unknown>;

const ALLOWED_TRANSITIONS: Record<SceneState, SceneState[]> = {
  draft: ["prompt_ready", "skipped"],
  prompt_ready: ["image_queued", "video_queued", "skipped"],
  image_queued: ["image_generating", "image_failed", "skipped"],
  image_generating: ["image_done", "image_failed", "skipped"],
  image_done: ["image_approved", "needs_review", "image_queued", "video_queued", "skipped"],
  image_failed: ["image_queued", "video_queued", "skipped"],
  image_approved: ["video_queued", "image_queued", "needs_review", "skipped"],
  video_queued: ["video_generating", "video_failed", "skipped"],
  video_generating: ["video_submitted", "video_done", "video_failed", "skipped"],
  video_submitted: ["video_queued", "video_failed", "skipped"],
  video_done: ["video_approved", "needs_review", "video_queued", "skipped"],
  video_failed: ["video_queued", "skipped"],
  video_approved: ["video_queued", "needs_review", "skipped"],
  needs_review: ["image_approved", "video_approved", "image_queued", "video_queued", "skipped"],
  skipped: ["prompt_ready"],
};

function canTransition(from: SceneState, to: SceneState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown): number {
  return Number(value || 0);
}

function bool(value: unknown): boolean {
  return integer(value) === 1;
}

function jsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(text(value));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function now(): string {
  return new Date().toISOString();
}

function mapProject(row: Row): ProjectRecord {
  return {
    id: text(row.id),
    name: text(row.name),
    createdAt: text(row.created_at),
    activeVisualBibleId: nullableText(row.active_visual_bible_id),
    autoApproveImages: bool(row.auto_approve_images),
    autoApproveVideos: bool(row.auto_approve_videos),
  };
}

function mapVisualBible(row: Row): VisualBibleRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    version: integer(row.version),
    stylePresetId: nullableText(row.style_preset_id),
    payloadJson: text(row.payload_json),
    contentHash: text(row.content_hash),
    locked: bool(row.locked),
    anchorImagePaths: jsonArray(row.anchor_image_paths),
    createdAt: text(row.created_at),
  };
}

function mapScene(row: Row): SceneRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    batchIndex: integer(row.batch_index),
    orderIndex: integer(row.order_index),
    timeStart: text(row.time_start),
    timeEnd: text(row.time_end),
    imagePrompt: text(row.image_prompt),
    videoPrompt: text(row.video_prompt),
    usedCharacterTokens: jsonArray(row.used_character_tokens),
    narrationSrtRange: nullableText(row.narration_srt_range),
    visualBibleId: nullableText(row.visual_bible_id),
    chainId: nullableText(row.chain_id),
    chainRole: text(row.chain_role) as SceneRecord["chainRole"],
    durationSeconds: integer(row.duration_seconds) as SceneRecord["durationSeconds"],
    startFrameAssetPath: nullableText(row.start_frame_asset_path),
    status: text(row.status) as SceneState,
    imageAssetPath: nullableText(row.image_asset_path),
    flowImageAssetId: nullableText(row.flow_image_asset_id),
    videoAssetPath: nullableText(row.video_asset_path),
    approvedImage: bool(row.approved_image),
    approvedVideo: bool(row.approved_video),
    lastError: nullableText(row.last_error),
    updatedAt: text(row.updated_at),
  };
}

function mapJob(row: Row): JobRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    sceneId: nullableText(row.scene_id),
    jobType: text(row.job_type),
    status: text(row.status) as JobState,
    dependsOn: nullableText(row.depends_on),
    attempts: integer(row.attempts),
    maxAttempts: integer(row.max_attempts),
    lastHeartbeatAt: nullableText(row.last_heartbeat_at),
    lastError: nullableText(row.last_error),
    payloadHash: text(row.payload_hash),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapStylePreset(row: Row): StylePresetRecord {
  return {
    id: text(row.id),
    name: text(row.name),
    category: text(row.category),
    paramSchemaJson: text(row.param_schema_json),
    templateJson: text(row.template_json),
    anchorImagePaths: jsonArray(row.anchor_image_paths),
  };
}

export class ProjectRepository {
  constructor(private readonly database: ProjectDatabase) {}

  create(input: { id?: string; name: string; createdAt?: string }): ProjectRecord {
    const id = input.id || randomUUID();
    const createdAt = input.createdAt || now();
    this.database.db.prepare(
      "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
    ).run(id, input.name.trim(), createdAt);
    return this.get(id)!;
  }

  get(id: string): ProjectRecord | null {
    const row = this.database.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  list(): ProjectRecord[] {
    return (this.database.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as Row[]).map(mapProject);
  }

  setActiveVisualBible(projectId: string, visualBibleId: string | null): void {
    this.database.db.prepare("UPDATE projects SET active_visual_bible_id = ? WHERE id = ?").run(visualBibleId, projectId);
  }

  setApprovalPolicy(projectId: string, images: boolean, videos: boolean): void {
    this.database.db.prepare(
      "UPDATE projects SET auto_approve_images = ?, auto_approve_videos = ? WHERE id = ?",
    ).run(images ? 1 : 0, videos ? 1 : 0, projectId);
  }

  rename(id: string, name: string): void {
    this.database.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name.trim(), id);
  }

  remove(id: string): void {
    this.database.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

export class VisualBibleRepository {
  constructor(private readonly database: ProjectDatabase) {}

  create(input: Omit<VisualBibleRecord, "createdAt"> & { createdAt?: string }): VisualBibleRecord {
    this.database.db.prepare(`
      INSERT INTO visual_bibles (
        id, project_id, version, style_preset_id, payload_json, content_hash,
        locked, anchor_image_paths, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.version,
      input.stylePresetId,
      input.payloadJson,
      input.contentHash,
      input.locked ? 1 : 0,
      JSON.stringify(input.anchorImagePaths),
      input.createdAt || now(),
    );
    return this.get(input.id)!;
  }

  get(id: string): VisualBibleRecord | null {
    const row = this.database.db.prepare("SELECT * FROM visual_bibles WHERE id = ?").get(id) as Row | undefined;
    return row ? mapVisualBible(row) : null;
  }

  listByProject(projectId: string): VisualBibleRecord[] {
    return (this.database.db.prepare(
      "SELECT * FROM visual_bibles WHERE project_id = ? ORDER BY version",
    ).all(projectId) as Row[]).map(mapVisualBible);
  }

  setAnchors(id: string, paths: string[], locked = true): VisualBibleRecord {
    this.database.db.prepare(
      "UPDATE visual_bibles SET anchor_image_paths = ?, locked = ? WHERE id = ?",
    ).run(JSON.stringify([...new Set(paths)].slice(0, 5)), locked ? 1 : 0, id);
    return this.get(id)!;
  }
}

export class SceneRepository {
  constructor(
    private readonly database: ProjectDatabase,
    private readonly jobs: JobRepository,
  ) {}

  create(input: SceneRecord): SceneRecord {
    this.database.db.prepare(`
      INSERT INTO scenes (
        id, project_id, batch_index, order_index, time_start, time_end,
        image_prompt, video_prompt, used_character_tokens, narration_srt_range,
        visual_bible_id, chain_id, chain_role, duration_seconds, start_frame_asset_path,
        status, image_asset_path, flow_image_asset_id, video_asset_path,
        approved_image, approved_video, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.projectId, input.batchIndex, input.orderIndex,
      input.timeStart, input.timeEnd, input.imagePrompt, input.videoPrompt,
      JSON.stringify(input.usedCharacterTokens), input.narrationSrtRange,
      input.visualBibleId, input.chainId, input.chainRole, input.durationSeconds,
      input.startFrameAssetPath, input.status, input.imageAssetPath,
      input.flowImageAssetId, input.videoAssetPath, input.approvedImage ? 1 : 0,
      input.approvedVideo ? 1 : 0, input.lastError, input.updatedAt,
    );
    return this.get(input.id)!;
  }

  get(id: string): SceneRecord | null {
    const row = this.database.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as Row | undefined;
    return row ? mapScene(row) : null;
  }

  listByProject(projectId: string): SceneRecord[] {
    return (this.database.db.prepare(
      "SELECT * FROM scenes WHERE project_id = ? ORDER BY order_index",
    ).all(projectId) as Row[]).map(mapScene);
  }

  updatePrompts(
    id: string,
    imagePrompt: string,
    videoPrompt: string,
    usedCharacterTokens?: string[],
  ): SceneRecord {
    this.database.db.prepare(`
      UPDATE scenes SET image_prompt = ?, video_prompt = ?,
        used_character_tokens = COALESCE(?, used_character_tokens), updated_at = ?
      WHERE id = ?
    `).run(
      imagePrompt,
      videoPrompt,
      usedCharacterTokens ? JSON.stringify(usedCharacterTokens) : null,
      now(),
      id,
    );
    return this.get(id)!;
  }

  setStartFrameAssetPath(id: string, path: string | null): SceneRecord {
    this.database.db.prepare(
      "UPDATE scenes SET start_frame_asset_path = ?, updated_at = ? WHERE id = ?",
    ).run(path, now(), id);
    return this.get(id)!;
  }

  clearContinuationFrame(id: string): SceneRecord {
    this.database.db.prepare(`
      UPDATE scenes SET
        start_frame_asset_path = NULL,
        image_asset_path = NULL,
        flow_image_asset_id = NULL,
        approved_image = 0,
        approved_video = 0,
        status = 'prompt_ready',
        last_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    return this.get(id)!;
  }

  useContinuationFrameAsOpeningImage(id: string, path: string): SceneRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Scene ${id} does not exist`);
    if (current.chainRole !== "continue") {
      throw new Error(`Scene ${id} is not a continuation`);
    }
    this.database.db.prepare(`
      UPDATE scenes SET
        start_frame_asset_path = ?, status = 'image_approved',
        image_asset_path = ?, flow_image_asset_id = NULL,
        approved_image = 1, approved_video = 0,
        last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(path, path, now(), id);
    return this.get(id)!;
  }

  resetPendingQueueState(id: string): SceneRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Scene ${id} does not exist`);
    const imagePending = current.status === "image_queued" || current.status === "image_failed";
    const videoPending = current.status === "video_queued" ||
      current.status === "video_failed" ||
      current.status === "video_submitted";
    if (!imagePending && !videoPending) return current;
    const status: SceneState = imagePending
      ? "prompt_ready"
      : current.imageAssetPath
        ? "image_approved"
        : "prompt_ready";
    this.database.db.prepare(`
      UPDATE scenes SET status = ?, approved_image = ?, approved_video = 0,
        last_error = NULL, updated_at = ? WHERE id = ?
    `).run(status, status === "image_approved" ? 1 : 0, now(), id);
    return this.get(id)!;
  }

  updateState(input: {
    sceneId: string;
    to: SceneState;
    error?: string | null;
    imageAssetPath?: string | null;
    flowImageAssetId?: string | null;
    videoAssetPath?: string | null;
    approvedImage?: boolean;
    approvedVideo?: boolean;
    allowRecovery?: boolean;
  }): SceneRecord {
    const current = this.get(input.sceneId);
    if (!current) throw new Error(`Scene ${input.sceneId} does not exist`);
    const recoveryTransition = input.allowRecovery && (
      (current.status === "image_generating" && input.to === "image_queued") ||
      (current.status === "video_generating" && input.to === "video_queued")
    );
    if (!canTransition(current.status, input.to) && !recoveryTransition) {
      throw new Error(`Invalid scene transition ${current.status} -> ${input.to}`);
    }
    this.database.db.prepare(`
      UPDATE scenes SET
        status = ?, image_asset_path = ?, flow_image_asset_id = ?, video_asset_path = ?,
        approved_image = ?, approved_video = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.to,
      input.imageAssetPath === undefined ? current.imageAssetPath : input.imageAssetPath,
      input.flowImageAssetId === undefined ? current.flowImageAssetId : input.flowImageAssetId,
      input.videoAssetPath === undefined ? current.videoAssetPath : input.videoAssetPath,
      (input.approvedImage ?? current.approvedImage) ? 1 : 0,
      (input.approvedVideo ?? current.approvedVideo) ? 1 : 0,
      input.error === undefined ? current.lastError : input.error,
      now(),
      input.sceneId,
    );
    return this.get(input.sceneId)!;
  }

  resetForMedia(sceneId: string, mediaType: "image" | "video"): SceneRecord {
    const current = this.get(sceneId);
    if (!current) throw new Error(`Scene ${sceneId} does not exist`);
    const hasOpeningImage = Boolean(current.imageAssetPath);
    const status: SceneState = mediaType === "image"
      ? "prompt_ready"
      : hasOpeningImage
        ? "image_approved"
        : "prompt_ready";
    this.database.db.prepare(`
      UPDATE scenes SET
        status = ?, image_asset_path = ?, flow_image_asset_id = ?, video_asset_path = NULL,
        approved_image = ?, approved_video = 0, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      mediaType === "image" ? null : current.imageAssetPath,
      mediaType === "image" ? null : current.flowImageAssetId,
      mediaType === "video" && hasOpeningImage ? 1 : 0,
      now(),
      sceneId,
    );
    return this.get(sceneId)!;
  }

  transition(input: {
    sceneId: string;
    to: SceneState;
    jobType: string;
    payloadHash: string;
    jobStatus?: JobState;
    error?: string | null;
    maxAttempts?: number;
    dependsOn?: string | null;
  }): { scene: SceneRecord; job: JobRecord } {
    return this.database.transaction(() => {
      const current = this.get(input.sceneId);
      if (!current) throw new Error(`Scene ${input.sceneId} does not exist`);
      if (!ALLOWED_TRANSITIONS[current.status].includes(input.to)) {
        throw new Error(`Invalid scene transition ${current.status} -> ${input.to}`);
      }
      const updatedAt = now();
      const approvedImage = input.to === "image_approved" ? 1 : current.approvedImage ? 1 : 0;
      const approvedVideo = input.to === "video_approved" ? 1 : current.approvedVideo ? 1 : 0;
      this.database.db.prepare(`
        UPDATE scenes
        SET status = ?, approved_image = ?, approved_video = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(input.to, approvedImage, approvedVideo, input.error || null, updatedAt, input.sceneId);
      const job = this.jobs.create({
        id: randomUUID(),
        projectId: current.projectId,
        sceneId: input.sceneId,
        jobType: input.jobType,
        status: input.jobStatus || "queued",
        dependsOn: input.dependsOn || null,
        attempts: 0,
        maxAttempts: input.maxAttempts || 3,
        lastHeartbeatAt: null,
        lastError: input.error || null,
        payloadHash: input.payloadHash,
        createdAt: updatedAt,
        updatedAt,
      });
      return { scene: this.get(input.sceneId)!, job };
    });
  }
}

export class JobRepository {
  constructor(private readonly database: ProjectDatabase) {}

  create(input: JobRecord): JobRecord {
    this.database.db.prepare(`
      INSERT INTO jobs (
        id, project_id, scene_id, job_type, status, depends_on, attempts, max_attempts,
        last_heartbeat_at, last_error, payload_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.projectId, input.sceneId, input.jobType, input.status, input.dependsOn,
      input.attempts, input.maxAttempts, input.lastHeartbeatAt, input.lastError,
      input.payloadHash, input.createdAt, input.updatedAt,
    );
    return this.get(input.id)!;
  }

  get(id: string): JobRecord | null {
    const row = this.database.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  listByScene(sceneId: string): JobRecord[] {
    return (this.database.db.prepare(
      "SELECT * FROM jobs WHERE scene_id = ? ORDER BY created_at, id",
    ).all(sceneId) as Row[]).map(mapJob);
  }

  listByProject(projectId: string): JobRecord[] {
    return (this.database.db.prepare(
      "SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at, id",
    ).all(projectId) as Row[]).map(mapJob);
  }

  findActive(sceneId: string, jobType: string): JobRecord | null {
    const row = this.database.db.prepare(`
      SELECT * FROM jobs
      WHERE scene_id = ? AND job_type = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(sceneId, jobType) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  nextRunnable(projectId: string): JobRecord | null {
    const row = this.database.db.prepare(`
      SELECT child.* FROM jobs child
      LEFT JOIN jobs parent ON parent.id = child.depends_on
      LEFT JOIN scenes ON scenes.id = child.scene_id
      WHERE child.project_id = ? AND child.status = 'queued'
        AND (child.depends_on IS NULL OR parent.status = 'succeeded')
      ORDER BY COALESCE(scenes.order_index, -1), child.created_at, child.id
      LIMIT 1
    `).get(projectId) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  listRetryableFailures(projectId: string): JobRecord[] {
    return (this.database.db.prepare(`
      SELECT * FROM jobs
      WHERE project_id = ? AND status = 'failed' AND attempts < max_attempts
      ORDER BY updated_at, id
    `).all(projectId) as Row[]).map(mapJob);
  }

  removePendingByProject(projectId: string): JobRecord[] {
    const pending = (this.database.db.prepare(`
      SELECT * FROM jobs WHERE project_id = ? AND status IN ('queued', 'failed')
      ORDER BY created_at, id
    `).all(projectId) as Row[]).map(mapJob);
    this.database.db.prepare(
      "DELETE FROM jobs WHERE project_id = ? AND status IN ('queued', 'failed')",
    ).run(projectId);
    return pending;
  }

  recoverRunning(projectId?: string): JobRecord[] {
    const rows = (projectId
      ? this.database.db.prepare("SELECT * FROM jobs WHERE project_id = ? AND status = 'running'").all(projectId)
      : this.database.db.prepare("SELECT * FROM jobs WHERE status = 'running'").all()) as Row[];
    const recovered: JobRecord[] = [];
    for (const row of rows) {
      recovered.push(this.updateStatus(text(row.id), "queued", {
        heartbeatAt: null,
        error: null,
      }));
    }
    return recovered;
  }

  updateStatus(id: string, status: JobState, values: {
    attempts?: number;
    heartbeatAt?: string | null;
    error?: string | null;
  } = {}): JobRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Job ${id} does not exist`);
    this.database.db.prepare(`
      UPDATE jobs SET status = ?, attempts = ?, last_heartbeat_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      values.attempts ?? current.attempts,
      values.heartbeatAt === undefined ? current.lastHeartbeatAt : values.heartbeatAt,
      values.error === undefined ? current.lastError : values.error,
      now(),
      id,
    );
    return this.get(id)!;
  }
}

export class ProjectSourceRepository {
  constructor(private readonly database: ProjectDatabase) {}

  upsert(input: ProjectSourceRecord): ProjectSourceRecord {
    this.database.db.prepare(`
      INSERT INTO project_sources (
        project_id, srt_text, script_text, srt_file_name, script_file_name,
        srt_file_path, script_file_path, audio_file_path, audio_file_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        srt_text = excluded.srt_text,
        script_text = excluded.script_text,
        srt_file_name = excluded.srt_file_name,
        script_file_name = excluded.script_file_name,
        srt_file_path = excluded.srt_file_path,
        script_file_path = excluded.script_file_path,
        audio_file_path = excluded.audio_file_path,
        audio_file_name = excluded.audio_file_name,
        updated_at = excluded.updated_at
    `).run(
      input.projectId, input.srtText, input.scriptText, input.srtFileName,
      input.scriptFileName, input.srtFilePath, input.scriptFilePath,
      input.audioFilePath, input.audioFileName, input.updatedAt,
    );
    return this.get(input.projectId)!;
  }

  get(projectId: string): ProjectSourceRecord | null {
    const row = this.database.db.prepare(
      "SELECT * FROM project_sources WHERE project_id = ?",
    ).get(projectId) as Row | undefined;
    return row ? {
      projectId: text(row.project_id),
      srtText: text(row.srt_text),
      scriptText: text(row.script_text),
      srtFileName: nullableText(row.srt_file_name),
      scriptFileName: nullableText(row.script_file_name),
      srtFilePath: nullableText(row.srt_file_path),
      scriptFilePath: nullableText(row.script_file_path),
      audioFilePath: nullableText(row.audio_file_path),
      audioFileName: nullableText(row.audio_file_name),
      updatedAt: text(row.updated_at),
    } : null;
  }
}

export class ProjectCharacterRepository {
  constructor(private readonly database: ProjectDatabase) {}

  upsert(input: ProjectCharacterRecord): ProjectCharacterRecord {
    this.database.db.prepare(`
      INSERT INTO project_characters (
        project_id, token, name, ref_image_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, token) DO UPDATE SET
        name = excluded.name,
        ref_image_path = excluded.ref_image_path,
        updated_at = excluded.updated_at
    `).run(
      input.projectId, input.token, input.name, input.refImagePath,
      input.createdAt, input.updatedAt,
    );
    return this.get(input.projectId, input.token)!;
  }

  get(projectId: string, token: string): ProjectCharacterRecord | null {
    const row = this.database.db.prepare(`
      SELECT * FROM project_characters WHERE project_id = ? AND token = ?
    `).get(projectId, token) as Row | undefined;
    return row ? {
      projectId: text(row.project_id),
      token: text(row.token),
      name: text(row.name),
      refImagePath: text(row.ref_image_path),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    } : null;
  }

  listByProject(projectId: string): ProjectCharacterRecord[] {
    return (this.database.db.prepare(`
      SELECT * FROM project_characters WHERE project_id = ? ORDER BY token
    `).all(projectId) as Row[]).map((row) => ({
      projectId: text(row.project_id),
      token: text(row.token),
      name: text(row.name),
      refImagePath: text(row.ref_image_path),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }));
  }
}

export class StylePresetRepository {
  constructor(private readonly database: ProjectDatabase) {}

  upsert(input: StylePresetRecord): StylePresetRecord {
    this.database.db.prepare(`
      INSERT INTO style_presets (
        id, name, category, param_schema_json, template_json, anchor_image_paths
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        param_schema_json = excluded.param_schema_json,
        template_json = excluded.template_json,
        anchor_image_paths = excluded.anchor_image_paths
    `).run(
      input.id, input.name, input.category, input.paramSchemaJson,
      input.templateJson, JSON.stringify(input.anchorImagePaths),
    );
    return this.get(input.id)!;
  }

  get(id: string): StylePresetRecord | null {
    const row = this.database.db.prepare("SELECT * FROM style_presets WHERE id = ?").get(id) as Row | undefined;
    return row ? mapStylePreset(row) : null;
  }

  list(): StylePresetRecord[] {
    return (this.database.db.prepare("SELECT * FROM style_presets ORDER BY name").all() as Row[]).map(mapStylePreset);
  }

  remove(id: string): void {
    this.database.db.prepare("DELETE FROM style_presets WHERE id = ?").run(id);
  }
}

export class MetadataRepository {
  constructor(private readonly database: ProjectDatabase) {}

  get(key: string): string | null {
    const row = this.database.db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as Row | undefined;
    return row ? text(row.value) : null;
  }

  set(key: string, value: string): void {
    this.database.db.prepare(`
      INSERT INTO app_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

export class ProjectRepositories {
  readonly projects: ProjectRepository;
  readonly visualBibles: VisualBibleRepository;
  readonly jobs: JobRepository;
  readonly scenes: SceneRepository;
  readonly stylePresets: StylePresetRepository;
  readonly metadata: MetadataRepository;
  readonly sources: ProjectSourceRepository;
  readonly characters: ProjectCharacterRepository;

  constructor(readonly database: ProjectDatabase) {
    this.projects = new ProjectRepository(database);
    this.visualBibles = new VisualBibleRepository(database);
    this.jobs = new JobRepository(database);
    this.scenes = new SceneRepository(database, this.jobs);
    this.stylePresets = new StylePresetRepository(database);
    this.metadata = new MetadataRepository(database);
    this.sources = new ProjectSourceRepository(database);
    this.characters = new ProjectCharacterRepository(database);
  }
}
