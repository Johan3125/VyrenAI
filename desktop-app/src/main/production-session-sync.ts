import { createHash } from "node:crypto";
import type { Character } from "../shared/character";
import type { SceneState } from "../shared/project";
import type { TimelineSession } from "../shared/timeline";
import { DEFAULT_PROJECT_ID } from "../shared/production-queue";
import { APP_BRAND_NAME } from "../shared/brand";
import type { ProjectDatabase } from "./project-database";
import { ProjectRepositories } from "./project-repositories";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function storedState(scene: TimelineSession["scenes"][number]): SceneState {
  const approvedImage = "imageApproved" in scene && scene.imageApproved === true;
  const approvedVideo = "videoApproved" in scene && scene.videoApproved === true;
  if (scene.videoStatus === "error") return "video_failed";
  if (scene.videoStatus === "submitted") return "video_submitted";
  if (scene.videoResultPath) return approvedVideo ? "video_approved" : "video_done";
  if (scene.imageStatus === "error") return "image_failed";
  if (scene.imageResultPath) return approvedImage ? "image_approved" : "image_done";
  return "prompt_ready";
}

const ACTIVE_STATES = new Set<SceneState>([
  "image_queued",
  "image_generating",
  "video_queued",
  "video_generating",
  "video_submitted",
]);

function activeJobByTypes(
  repositories: ProjectRepositories,
  sceneId: string,
  jobTypes: string[],
) {
  const jobs = jobTypes.flatMap((jobType) => {
    const job = repositories.jobs.findActive(sceneId, jobType);
    return job ? [job] : [];
  });
  return jobs
    .sort((left, right) =>
      Number(right.status === "running") - Number(left.status === "running") ||
      right.updatedAt.localeCompare(left.updatedAt)
    )[0] || null;
}

export function syncTimelineSessionToProject(
  database: ProjectDatabase,
  session: TimelineSession,
  characters: Character[] = [],
  projectId = DEFAULT_PROJECT_ID,
): void {
  const repositories = new ProjectRepositories(database);
  const visualBibleId = `${projectId}:visual-bible:1`;
  database.transaction(() => {
    if (!repositories.projects.get(projectId)) {
      repositories.projects.create({
        id: projectId,
        name: session.name || `Dự án ${APP_BRAND_NAME} hiện tại`,
        createdAt: session.savedAt,
      });
    }

    repositories.sources.upsert({
      projectId,
      srtText: session.workflowSource.srtText,
      scriptText: session.workflowSource.scriptText,
      srtFileName: session.workflowSource.srtFileName || null,
      scriptFileName: session.workflowSource.scriptFileName || null,
      srtFilePath: session.workflowSource.srtPath || null,
      scriptFilePath: session.workflowSource.scriptPath || null,
      audioFilePath: session.workflowSource.audioPath || null,
      audioFileName: session.workflowSource.audioFileName || null,
      updatedAt: session.savedAt,
    });

    const visualBibleJson = JSON.stringify(session.visualBible);
    database.db.prepare(`
      INSERT INTO visual_bibles (
        id, project_id, version, style_preset_id, payload_json, content_hash,
        locked, anchor_image_paths, created_at
      ) VALUES (?, ?, 1, NULL, ?, ?, 0, '[]', ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        content_hash = excluded.content_hash
    `).run(visualBibleId, projectId, visualBibleJson, hash(visualBibleJson), session.savedAt);
    repositories.projects.setActiveVisualBible(projectId, visualBibleId);

    const incomingTokens = new Set(characters.map((character) => character.token));
    for (const character of repositories.characters.listByProject(projectId)) {
      if (!incomingTokens.has(character.token)) {
        database.db.prepare(
          "DELETE FROM project_characters WHERE project_id = ? AND token = ?",
        ).run(projectId, character.token);
      }
    }
    for (const character of characters) {
      repositories.characters.upsert({
        projectId,
        token: character.token,
        name: character.name,
        refImagePath: character.refImagePath,
        createdAt: session.savedAt,
        updatedAt: session.savedAt,
      });
    }

    const incomingIds = new Set<string>();
    for (const [index, scene] of session.scenes.entries()) {
      const sceneId = `${projectId}:${scene.id}`;
      incomingIds.add(sceneId);
      const existing = repositories.scenes.get(sceneId);
      const selectedTokens = scene.characterPolicy === "selected"
        ? scene.assignedCharacterTokens
        : [];
      const incomingState = storedState(scene);
      let activeImageJob = existing
        ? repositories.jobs.findActive(sceneId, "image_generation")
        : null;
      let activeVideoJob = existing
        ? activeJobByTypes(repositories, sceneId, [
          "video_generation",
          "video_generation_direct",
          "video_submission",
          "video_submission_direct",
        ])
        : null;
      const sessionSavedAt = Date.parse(session.savedAt);
      const supersedesQueuedImage = activeImageJob?.status === "queued" &&
        Boolean(scene.imageResultPath) &&
        Number.isFinite(sessionSavedAt) &&
        sessionSavedAt > Date.parse(activeImageJob.updatedAt);
      const supersedesQueuedVideo = activeVideoJob?.status === "queued" &&
        Boolean(scene.videoResultPath) &&
        Number.isFinite(sessionSavedAt) &&
        sessionSavedAt > Date.parse(activeVideoJob.updatedAt);
      if (supersedesQueuedImage && activeImageJob) {
        repositories.jobs.updateStatus(activeImageJob.id, "succeeded", {
          heartbeatAt: session.savedAt,
          error: null,
        });
        activeImageJob = null;
      }
      if (supersedesQueuedVideo && activeVideoJob) {
        repositories.jobs.updateStatus(activeVideoJob.id, "succeeded", {
          heartbeatAt: session.savedAt,
          error: null,
        });
        activeVideoJob = null;
      }
      const hasActiveExecution = activeImageJob?.status === "running" ||
        activeVideoJob?.status === "running" ||
        (activeImageJob?.status === "queued" && !scene.imageResultPath) ||
        (activeVideoJob?.status === "queued" && !scene.videoResultPath);
      const nextStatus = existing && ACTIVE_STATES.has(existing.status) && hasActiveExecution
        ? existing.status
        : incomingState;
      const approvedImage = "imageApproved" in scene && scene.imageApproved === true;
      const approvedVideo = "videoApproved" in scene && scene.videoApproved === true;
      if (!existing) {
        repositories.scenes.create({
          id: sceneId,
          projectId,
          batchIndex: Math.floor(index / 6),
          orderIndex: index,
          timeStart: scene.timeStart,
          timeEnd: scene.timeEnd,
          imagePrompt: scene.imagePrompt,
          videoPrompt: scene.videoPrompt,
          usedCharacterTokens: selectedTokens,
          narrationSrtRange: null,
          visualBibleId,
          chainId: scene.chainId,
          chainRole: scene.chainRole,
          durationSeconds: scene.durationSeconds,
          startFrameAssetPath: null,
          status: nextStatus,
          imageAssetPath: scene.imageResultPath || null,
          flowImageAssetId: scene.imageFlowAssetKey || null,
          videoAssetPath: scene.videoResultPath || null,
          approvedImage,
          approvedVideo,
          lastError: null,
          updatedAt: session.savedAt,
        });
      } else {
        database.db.prepare(`
          UPDATE scenes SET
            batch_index = ?, order_index = ?, time_start = ?, time_end = ?,
            image_prompt = ?, video_prompt = ?, used_character_tokens = ?,
            visual_bible_id = ?, chain_id = ?, chain_role = ?, duration_seconds = ?,
            status = ?, image_asset_path = ?, flow_image_asset_id = ?,
            video_asset_path = ?, approved_image = ?, approved_video = ?, updated_at = ?
          WHERE id = ?
        `).run(
          Math.floor(index / 6), index, scene.timeStart, scene.timeEnd,
          scene.imagePrompt, scene.videoPrompt,
          JSON.stringify(selectedTokens),
          visualBibleId, scene.chainId, scene.chainRole, scene.durationSeconds,
          nextStatus, scene.imageResultPath || null,
          scene.imageFlowAssetKey || null, scene.videoResultPath || null,
          approvedImage ? 1 : 0,
          approvedVideo ? 1 : 0,
          session.savedAt, sceneId,
        );
      }
    }

    const activeJobs = repositories.jobs.listByProject(projectId)
      .some((job) => job.status === "queued" || job.status === "running");
    if (!activeJobs) {
      for (const scene of repositories.scenes.listByProject(projectId)) {
        if (!incomingIds.has(scene.id)) {
          database.db.prepare("DELETE FROM scenes WHERE id = ?").run(scene.id);
        }
      }
    }
  });
}
