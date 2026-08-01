import { createHash } from "node:crypto";
import type { SceneState, StylePresetRecord } from "../shared/project";
import type { Character } from "../shared/character";
import type { TimelineSession } from "../shared/timeline";
import type { GraphicStylePreset } from "../shared/visual-style";
import type { ProjectDatabase } from "./project-database";
import { ProjectRepositories } from "./project-repositories";

export const LEGACY_PROJECT_ID = "legacy-default-project";
const LEGACY_VISUAL_BIBLE_ID = `${LEGACY_PROJECT_ID}:visual-bible:1`;
const LEGACY_HASH_KEY = "legacy_timeline_session_hash";

export interface LegacyMigrationResult {
  migrated: boolean;
  projectId: string | null;
  sceneCount: number;
  stylePresetCount: number;
  characterCount: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sceneState(scene: TimelineSession["scenes"][number]): SceneState {
  if (scene.videoStatus === "done" && scene.videoResultPath) return "video_done";
  if (scene.videoStatus === "submitted") return "video_submitted";
  if (scene.videoStatus === "error") return "video_failed";
  if (scene.imageStatus === "done" && scene.imageResultPath) return "image_done";
  if (scene.imageStatus === "error") return "image_failed";
  return "prompt_ready";
}

function presetCategory(style: string): string {
  if (/stick\s*[- ]?\s*(?:man|figure)/i.test(style)) return "stick_figure_2d";
  if (/\b3d\b|three-dimensional/i.test(style)) return "stylized_3d";
  if (/true.?crime|documentary|photoreal/i.test(style)) return "true_crime_doc";
  return "custom";
}

function migrateStylePresets(
  repositories: ProjectRepositories,
  presets: GraphicStylePreset[],
): number {
  for (const preset of presets) {
    const record: StylePresetRecord = {
      id: preset.id,
      name: preset.name,
      category: presetCategory(preset.style),
      paramSchemaJson: JSON.stringify({
        version: 1,
        fields: [],
        readOnlyTextPreset: true,
        builtIn: preset.builtIn,
      }),
      templateJson: JSON.stringify({ style: preset.style }),
      anchorImagePaths: [],
    };
    repositories.stylePresets.upsert(record);
  }
  return presets.length;
}

export function migrateLegacyProjectData(
  database: ProjectDatabase,
  session: TimelineSession | null,
  presets: GraphicStylePreset[] = [],
  characters: Character[] = [],
  options: { initialImportOnly?: boolean } = {},
): LegacyMigrationResult {
  const repositories = new ProjectRepositories(database);
  return database.transaction(() => {
    const stylePresetCount = migrateStylePresets(repositories, presets);
    if (!session?.scenes.length && characters.length === 0) {
      return { migrated: false, projectId: null, sceneCount: 0, stylePresetCount, characterCount: 0 };
    }

    const fingerprint = sha256(JSON.stringify({ session, characters }));
    const previousFingerprint = repositories.metadata.get(LEGACY_HASH_KEY);
    if (previousFingerprint === fingerprint || (options.initialImportOnly && previousFingerprint)) {
      return {
        migrated: false,
        projectId: LEGACY_PROJECT_ID,
        sceneCount: repositories.scenes.listByProject(LEGACY_PROJECT_ID).length,
        stylePresetCount,
        characterCount: repositories.characters.listByProject(LEGACY_PROJECT_ID).length,
      };
    }

    if (!repositories.projects.get(LEGACY_PROJECT_ID)) {
      repositories.projects.create({
        id: LEGACY_PROJECT_ID,
        name: "Project được chuyển từ phiên làm việc cũ",
        createdAt: session?.savedAt || new Date().toISOString(),
      });
    }

    const migrationTime = session?.savedAt || new Date().toISOString();
    database.db.prepare("DELETE FROM project_characters WHERE project_id = ?").run(LEGACY_PROJECT_ID);
    for (const character of characters) {
      repositories.characters.upsert({
        projectId: LEGACY_PROJECT_ID,
        token: character.token,
        name: character.name,
        refImagePath: character.refImagePath,
        createdAt: migrationTime,
        updatedAt: migrationTime,
      });
    }

    if (session?.scenes.length) {
      database.db.prepare("DELETE FROM scenes WHERE project_id = ?").run(LEGACY_PROJECT_ID);
      database.db.prepare("DELETE FROM visual_bibles WHERE project_id = ?").run(LEGACY_PROJECT_ID);

      const visualBiblePayload = JSON.stringify(session.visualBible);
      repositories.visualBibles.create({
        id: LEGACY_VISUAL_BIBLE_ID,
        projectId: LEGACY_PROJECT_ID,
        version: 1,
        stylePresetId: null,
        payloadJson: visualBiblePayload,
        contentHash: sha256(visualBiblePayload),
        locked: false,
        anchorImagePaths: [],
        createdAt: session.savedAt,
      });
      repositories.projects.setActiveVisualBible(LEGACY_PROJECT_ID, LEGACY_VISUAL_BIBLE_ID);

      for (const [index, scene] of session.scenes.entries()) {
        const selectedTokens = scene.characterPolicy === "selected"
          ? scene.assignedCharacterTokens
          : [];
        repositories.scenes.create({
          id: `${LEGACY_PROJECT_ID}:${scene.id}`,
          projectId: LEGACY_PROJECT_ID,
          batchIndex: Math.floor(index / 6),
          orderIndex: index,
          timeStart: scene.timeStart,
          timeEnd: scene.timeEnd,
          imagePrompt: scene.imagePrompt,
          videoPrompt: scene.videoPrompt,
          usedCharacterTokens: selectedTokens,
          narrationSrtRange: null,
          visualBibleId: LEGACY_VISUAL_BIBLE_ID,
          chainId: null,
          chainRole: "single",
          durationSeconds: 8,
          startFrameAssetPath: null,
          status: sceneState(scene),
          imageAssetPath: scene.imageResultPath || null,
          flowImageAssetId: scene.imageFlowAssetKey || null,
          videoAssetPath: scene.videoResultPath || null,
          approvedImage: false,
          approvedVideo: false,
          lastError: null,
          updatedAt: session.savedAt,
        });
      }
    }

    repositories.metadata.set(LEGACY_HASH_KEY, fingerprint);
    return {
      migrated: true,
      projectId: LEGACY_PROJECT_ID,
      sceneCount: session?.scenes.length || 0,
      stylePresetCount,
      characterCount: characters.length,
    };
  });
}
