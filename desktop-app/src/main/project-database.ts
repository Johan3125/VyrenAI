import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 4;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active_visual_bible_id TEXT,
  auto_approve_images INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve_images IN (0, 1)),
  auto_approve_videos INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve_videos IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS visual_bibles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  style_preset_id TEXT,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  anchor_image_paths TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL,
  time_start TEXT NOT NULL,
  time_end TEXT NOT NULL,
  image_prompt TEXT NOT NULL,
  video_prompt TEXT NOT NULL,
  used_character_tokens TEXT NOT NULL DEFAULT '[]',
  narration_srt_range TEXT,
  visual_bible_id TEXT REFERENCES visual_bibles(id) ON DELETE SET NULL,
  chain_id TEXT,
  chain_role TEXT NOT NULL DEFAULT 'single' CHECK (chain_role IN ('single', 'start', 'continue')),
  duration_seconds INTEGER NOT NULL DEFAULT 8 CHECK (duration_seconds IN (4, 6, 8)),
  start_frame_asset_path TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'prompt_ready', 'image_queued', 'image_generating', 'image_done',
    'image_failed', 'image_approved', 'video_queued', 'video_generating',
    'video_submitted', 'video_done', 'video_failed', 'video_approved', 'needs_review', 'skipped'
  )),
  image_asset_path TEXT,
  flow_image_asset_id TEXT,
  video_asset_path TEXT,
  approved_image INTEGER NOT NULL DEFAULT 0 CHECK (approved_image IN (0, 1)),
  approved_video INTEGER NOT NULL DEFAULT 0 CHECK (approved_video IN (0, 1)),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, order_index)
) STRICT;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  depends_on TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  last_heartbeat_at TEXT,
  last_error TEXT,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS style_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  param_schema_json TEXT NOT NULL,
  template_json TEXT NOT NULL,
  anchor_image_paths TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_visual_bibles_project ON visual_bibles(project_id, version);
CREATE INDEX IF NOT EXISTS idx_scenes_project_order ON scenes(project_id, order_index);
CREATE INDEX IF NOT EXISTS idx_scenes_project_status ON scenes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_scene_status ON jobs(scene_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_depends_on ON jobs(depends_on);
`;

const MIGRATION_2 = `
ALTER TABLE jobs RENAME TO jobs_v1;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  depends_on TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  last_heartbeat_at TEXT,
  last_error TEXT,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO jobs (
  id, project_id, scene_id, job_type, status, depends_on, attempts, max_attempts,
  last_heartbeat_at, last_error, payload_hash, created_at, updated_at
)
SELECT
  jobs_v1.id, scenes.project_id, jobs_v1.scene_id, jobs_v1.job_type,
  jobs_v1.status, jobs_v1.depends_on, jobs_v1.attempts, jobs_v1.max_attempts,
  jobs_v1.last_heartbeat_at, jobs_v1.last_error, jobs_v1.payload_hash,
  jobs_v1.created_at, jobs_v1.updated_at
FROM jobs_v1
JOIN scenes ON scenes.id = jobs_v1.scene_id;

DROP TABLE jobs_v1;

CREATE TABLE project_sources (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  srt_text TEXT NOT NULL DEFAULT '',
  script_text TEXT NOT NULL DEFAULT '',
  srt_file_name TEXT,
  script_file_name TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_characters (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  name TEXT NOT NULL,
  ref_image_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, token)
) STRICT;

CREATE INDEX idx_jobs_project_status ON jobs(project_id, status);
CREATE INDEX idx_jobs_scene_status ON jobs(scene_id, status);
CREATE INDEX idx_jobs_depends_on ON jobs(depends_on);
CREATE INDEX idx_project_characters_project ON project_characters(project_id, token);
`;

const MIGRATION_3 = `
ALTER TABLE project_sources ADD COLUMN srt_file_path TEXT;
ALTER TABLE project_sources ADD COLUMN script_file_path TEXT;
ALTER TABLE project_sources ADD COLUMN audio_file_path TEXT;
ALTER TABLE project_sources ADD COLUMN audio_file_name TEXT;
`;

const MIGRATION_4 = `
PRAGMA legacy_alter_table = ON;
ALTER TABLE scenes RENAME TO scenes_v3;

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL,
  time_start TEXT NOT NULL,
  time_end TEXT NOT NULL,
  image_prompt TEXT NOT NULL,
  video_prompt TEXT NOT NULL,
  used_character_tokens TEXT NOT NULL DEFAULT '[]',
  narration_srt_range TEXT,
  visual_bible_id TEXT REFERENCES visual_bibles(id) ON DELETE SET NULL,
  chain_id TEXT,
  chain_role TEXT NOT NULL DEFAULT 'single' CHECK (chain_role IN ('single', 'start', 'continue')),
  duration_seconds INTEGER NOT NULL DEFAULT 8 CHECK (duration_seconds IN (4, 6, 8)),
  start_frame_asset_path TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'prompt_ready', 'image_queued', 'image_generating', 'image_done',
    'image_failed', 'image_approved', 'video_queued', 'video_generating',
    'video_submitted', 'video_done', 'video_failed', 'video_approved', 'needs_review', 'skipped'
  )),
  image_asset_path TEXT,
  flow_image_asset_id TEXT,
  video_asset_path TEXT,
  approved_image INTEGER NOT NULL DEFAULT 0 CHECK (approved_image IN (0, 1)),
  approved_video INTEGER NOT NULL DEFAULT 0 CHECK (approved_video IN (0, 1)),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, order_index)
) STRICT;

INSERT INTO scenes (
  id, project_id, batch_index, order_index, time_start, time_end,
  image_prompt, video_prompt, used_character_tokens, narration_srt_range,
  visual_bible_id, chain_id, chain_role, duration_seconds, start_frame_asset_path,
  status, image_asset_path, flow_image_asset_id, video_asset_path,
  approved_image, approved_video, last_error, updated_at
)
SELECT
  id, project_id, batch_index, order_index, time_start, time_end,
  image_prompt, video_prompt, used_character_tokens, narration_srt_range,
  visual_bible_id, chain_id, chain_role, duration_seconds, start_frame_asset_path,
  status, image_asset_path, flow_image_asset_id, video_asset_path,
  approved_image, approved_video, last_error, updated_at
FROM scenes_v3;

ALTER TABLE jobs RENAME TO jobs_v3;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  depends_on TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  last_heartbeat_at TEXT,
  last_error TEXT,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO jobs (
  id, project_id, scene_id, job_type, status, depends_on, attempts, max_attempts,
  last_heartbeat_at, last_error, payload_hash, created_at, updated_at
)
SELECT
  id, project_id, scene_id, job_type, status, depends_on, attempts, max_attempts,
  last_heartbeat_at, last_error, payload_hash, created_at, updated_at
FROM jobs_v3;

DROP TABLE jobs_v3;
DROP TABLE scenes_v3;
CREATE INDEX IF NOT EXISTS idx_scenes_project_order ON scenes(project_id, order_index);
CREATE INDEX IF NOT EXISTS idx_scenes_project_status ON scenes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_scene_status ON jobs(scene_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_depends_on ON jobs(depends_on);
PRAGMA legacy_alter_table = OFF;
`;

export class ProjectDatabase {
  private connection: DatabaseSync | null = null;

  constructor(readonly path: string) {}

  async initialize(): Promise<void> {
    if (this.connection) return;
    await mkdir(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.connection = database;
    this.migrate();
  }

  get db(): DatabaseSync {
    if (!this.connection) throw new Error("Project database is not initialized");
    return this.connection;
  }

  get schemaVersion(): number {
    return Number(this.db.prepare("PRAGMA user_version").get()?.user_version || 0);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
  }

  private migrate(): void {
    let current = this.schemaVersion;
    if (current > SCHEMA_VERSION) {
      throw new Error(`Project DB schema ${current} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (current < 1) {
      this.transaction(() => {
        this.db.exec(MIGRATION_1);
        this.db.exec("PRAGMA user_version = 1");
      });
      current = 1;
    }
    if (current < 2) {
      this.transaction(() => {
        this.db.exec(MIGRATION_2);
        this.db.exec("PRAGMA user_version = 2");
      });
      current = 2;
    }
    if (current < 3) {
      this.transaction(() => {
        this.db.exec(MIGRATION_3);
        this.db.exec("PRAGMA user_version = 3");
      });
      current = 3;
    }
    if (current < 4) {
      this.transaction(() => {
        this.db.exec(MIGRATION_4);
        this.db.exec("PRAGMA user_version = 4");
      });
    }
  }
}
