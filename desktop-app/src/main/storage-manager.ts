import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ProjectDatabase } from "./project-database";
import { STORAGE_FOLDER_NAME } from "../shared/brand";

const DATA_DIRECTORIES = [
  "timeline-session",
  "character-library",
  "visual-style-library",
  "project-database",
  "provider-settings",
] as const;

export interface StorageLayout {
  root: string;
  dataRoot: string;
  outputRoot: string;
  backupRoot: string;
  source: "environment" | "drive-d" | "fallback";
}

export interface StorageMigrationSource {
  sourcePath: string;
  targetPath: string;
}

export interface StorageMigrationResult {
  migrated: boolean;
  copiedFiles: number;
  copiedBytes: number;
  sources: StorageMigrationSource[];
  pathMappings: Array<{ from: string; to: string }>;
}

interface ResolveStorageOptions {
  platform?: NodeJS.Platform;
  environmentRoot?: string;
  flowxDataRoot?: string;
  documentsRoot: string;
  driveDExists?: boolean;
}

interface PrepareStorageOptions {
  legacyUserDataRoot: string;
  legacyOutputRoot: string;
  previousStorageRoot?: string;
}

export interface StoragePreference {
  version: 1;
  rootPath: string;
  previousRootPath?: string;
  updatedAt: string;
}

interface CopySummary {
  files: number;
  bytes: number;
}

function safeAbsolutePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return resolve(trimmed);
}

export function resolveStorageLayout(options: ResolveStorageOptions): StorageLayout {
  const platform = options.platform || process.platform;
  const environmentRoot = safeAbsolutePath(options.environmentRoot || "");
  const flowxDataRoot = safeAbsolutePath(options.flowxDataRoot || "");
  if (flowxDataRoot) {
    return {
      root: flowxDataRoot,
      dataRoot: flowxDataRoot,
      outputRoot: join(flowxDataRoot, "outputs"),
      backupRoot: join(flowxDataRoot, "backups"),
      source: "environment",
    };
  }
  const driveDExists = options.driveDExists ?? (platform === "win32" && existsSync("D:\\"));
  const root = environmentRoot || (
    platform === "win32" && driveDExists
      ? `D:\\${STORAGE_FOLDER_NAME}`
      : join(options.documentsRoot, STORAGE_FOLDER_NAME)
  );
  return {
    root,
    dataRoot: join(root, "Data"),
    outputRoot: join(root, "Outputs"),
    backupRoot: join(root, "Backups"),
    source: environmentRoot ? "environment" : driveDExists ? "drive-d" : "fallback",
  };
}

export async function readStoragePreference(path: string): Promise<StoragePreference | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoragePreference>;
    const rootPath = safeAbsolutePath(parsed.rootPath || "");
    const previousRootPath = safeAbsolutePath(parsed.previousRootPath || "") || undefined;
    if (parsed.version !== 1 || !rootPath) return null;
    return {
      version: 1,
      rootPath,
      previousRootPath,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeStoragePreference(
  path: string,
  rootPath: string,
  previousRootPath?: string,
): Promise<StoragePreference> {
  const root = safeAbsolutePath(rootPath);
  const previous = safeAbsolutePath(previousRootPath || "") || undefined;
  if (!root) throw new Error("Thư mục lưu trữ phải là đường dẫn tuyệt đối.");
  const preference: StoragePreference = {
    version: 1,
    rootPath: root,
    previousRootPath: previous && !samePath(previous, root) ? previous : undefined,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, JSON.stringify(preference, null, 2), "utf8");
  await rm(path, { force: true });
  await rename(temporaryPath, path);
  return preference;
}

function samePath(left: string, right: string): boolean {
  return normalize(resolve(left)).toLocaleLowerCase("en-US") === normalize(resolve(right)).toLocaleLowerCase("en-US");
}

async function copyDirectoryMerged(source: string, target: string): Promise<CopySummary> {
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) return { files: 0, bytes: 0 };
  await mkdir(target, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyDirectoryMerged(sourcePath, targetPath);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!entry.isFile()) continue;
    const sourceFile = await stat(sourcePath);
    const targetFile = await stat(targetPath).catch(() => null);
    if (!targetFile?.isFile() || targetFile.size !== sourceFile.size || targetFile.mtimeMs < sourceFile.mtimeMs) {
      await mkdir(dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.kc-migrate-${randomUUID()}`;
      await copyFile(sourcePath, temporaryPath);
      await rm(targetPath, { force: true });
      await rename(temporaryPath, targetPath);
    }
    const verified = await stat(targetPath);
    if (!verified.isFile() || verified.size !== sourceFile.size) {
      throw new Error(`Không thể xác minh file sau khi chuyển: ${sourcePath}`);
    }
    files += 1;
    bytes += sourceFile.size;
  }
  return { files, bytes };
}

function rebasedPath(value: string, mappings: Array<{ from: string; to: string }>): string {
  const slashValue = value.replace(/\\/g, "/");
  const lowerValue = slashValue.toLocaleLowerCase("en-US");
  for (const mapping of mappings) {
    const from = resolve(mapping.from).replace(/\\/g, "/").replace(/\/$/, "");
    const to = resolve(mapping.to).replace(/\\/g, "/").replace(/\/$/, "");
    const lowerFrom = from.toLocaleLowerCase("en-US");
    if (lowerValue !== lowerFrom && !lowerValue.startsWith(`${lowerFrom}/`)) continue;
    const suffix = slashValue.slice(from.length).replace(/^\/+/, "");
    return normalize(suffix ? `${to}/${suffix}` : to);
  }
  return value;
}

function rebaseJsonValue(value: unknown, mappings: Array<{ from: string; to: string }>): unknown {
  if (typeof value === "string") return rebasedPath(value, mappings);
  if (Array.isArray(value)) return value.map((entry) => rebaseJsonValue(entry, mappings));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebaseJsonValue(entry, mappings)]));
}

async function rebaseJsonFiles(directory: string, mappings: Array<{ from: string; to: string }>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rebaseJsonFiles(path, mappings);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLocaleLowerCase("en-US").endsWith(".json")) continue;
    const source = await readFile(path, "utf8").catch(() => "");
    if (!source.trim()) continue;
    try {
      const parsed = JSON.parse(source) as unknown;
      const rebased = JSON.stringify(rebaseJsonValue(parsed, mappings), null, 2);
      if (rebased !== JSON.stringify(parsed, null, 2)) await writeFile(path, rebased, "utf8");
    } catch {
      // A non-JSON file with a .json suffix must not block application startup.
    }
  }
}

export async function prepareStorage(
  layout: StorageLayout,
  options: PrepareStorageOptions,
): Promise<StorageMigrationResult> {
  await Promise.all([
    mkdir(layout.dataRoot, { recursive: true }),
    mkdir(layout.outputRoot, { recursive: true }),
    mkdir(layout.backupRoot, { recursive: true }),
  ]);
  const sourceMap = new Map<string, StorageMigrationSource>();
  const addSource = async (sourcePath: string, targetPath: string, protectExistingTarget = false) => {
    if (samePath(sourcePath, targetPath) || !(await stat(sourcePath).catch(() => null))?.isDirectory()) return;
    // Session JSON and SQLite are authoritative state, not mergeable assets.
    // Never let a stale AppData copy replace an already-populated selected
    // storage root. Leaving the source out of `sources` also prevents cleanup
    // from deleting the conflicting copy, so it remains available for recovery.
    if (protectExistingTarget && (await readdir(targetPath).catch(() => [])).length > 0) return;
    sourceMap.set(normalize(resolve(sourcePath)).toLocaleLowerCase("en-US"), { sourcePath, targetPath });
  };
  for (const name of DATA_DIRECTORIES) {
    const sourcePath = join(options.legacyUserDataRoot, name);
    const targetPath = join(layout.dataRoot, name);
    await addSource(sourcePath, targetPath, true);
  }
  const legacyBackupRoot = join(options.legacyUserDataRoot, "capcut-backups");
  const targetBackupRoot = join(layout.backupRoot, "capcut-backups");
  await addSource(legacyBackupRoot, targetBackupRoot);
  await addSource(options.legacyOutputRoot, layout.outputRoot);
  const previousStorageRoot = safeAbsolutePath(options.previousStorageRoot || "");
  if (previousStorageRoot && !samePath(previousStorageRoot, layout.root)) {
    await addSource(join(previousStorageRoot, "Data"), layout.dataRoot, true);
    await addSource(join(previousStorageRoot, "Outputs"), layout.outputRoot);
    await addSource(join(previousStorageRoot, "Backups"), layout.backupRoot);
  }

  const sources = [...sourceMap.values()];

  let copiedFiles = 0;
  let copiedBytes = 0;
  for (const source of sources) {
    const copied = await copyDirectoryMerged(source.sourcePath, source.targetPath);
    copiedFiles += copied.files;
    copiedBytes += copied.bytes;
  }
  const pathMappings = [
    { from: options.legacyOutputRoot, to: layout.outputRoot },
    { from: options.legacyUserDataRoot, to: layout.dataRoot },
    ...(previousStorageRoot && !samePath(previousStorageRoot, layout.root) ? [
      { from: join(previousStorageRoot, "Data"), to: layout.dataRoot },
      { from: join(previousStorageRoot, "Outputs"), to: layout.outputRoot },
      { from: join(previousStorageRoot, "Backups"), to: layout.backupRoot },
    ] : []),
  ];
  await rebaseJsonFiles(layout.dataRoot, pathMappings);
  return {
    migrated: sources.length > 0,
    copiedFiles,
    copiedBytes,
    sources,
    pathMappings,
  };
}

function updateJsonColumn(
  database: ProjectDatabase,
  table: string,
  idColumn: string,
  valueColumn: string,
  mappings: Array<{ from: string; to: string }>,
): void {
  const rows = database.db.prepare(`SELECT ${idColumn} AS id, ${valueColumn} AS value FROM ${table}`).all() as Array<{ id: string; value: string | null }>;
  const update = database.db.prepare(`UPDATE ${table} SET ${valueColumn} = ? WHERE ${idColumn} = ?`);
  for (const row of rows) {
    if (!row.value) continue;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      const next = JSON.stringify(rebaseJsonValue(parsed, mappings));
      if (next !== row.value) update.run(next, row.id);
    } catch {
      const next = rebasedPath(row.value, mappings);
      if (next !== row.value) update.run(next, row.id);
    }
  }
}

export function rebaseProjectDatabasePaths(
  database: ProjectDatabase,
  mappings: Array<{ from: string; to: string }>,
): void {
  database.transaction(() => {
    const sceneRows = database.db.prepare(`
      SELECT id, start_frame_asset_path, image_asset_path, video_asset_path FROM scenes
    `).all() as Array<Record<string, string | null>>;
    const updateScene = database.db.prepare(`
      UPDATE scenes SET start_frame_asset_path = ?, image_asset_path = ?, video_asset_path = ? WHERE id = ?
    `);
    for (const row of sceneRows) {
      updateScene.run(
        row.start_frame_asset_path ? rebasedPath(row.start_frame_asset_path, mappings) : null,
        row.image_asset_path ? rebasedPath(row.image_asset_path, mappings) : null,
        row.video_asset_path ? rebasedPath(row.video_asset_path, mappings) : null,
        row.id,
      );
    }
    const sourceRows = database.db.prepare(`
      SELECT project_id, srt_file_path, script_file_path, audio_file_path FROM project_sources
    `).all() as Array<Record<string, string | null>>;
    const updateSource = database.db.prepare(`
      UPDATE project_sources SET srt_file_path = ?, script_file_path = ?, audio_file_path = ? WHERE project_id = ?
    `);
    for (const row of sourceRows) {
      updateSource.run(
        row.srt_file_path ? rebasedPath(row.srt_file_path, mappings) : null,
        row.script_file_path ? rebasedPath(row.script_file_path, mappings) : null,
        row.audio_file_path ? rebasedPath(row.audio_file_path, mappings) : null,
        row.project_id,
      );
    }
    const characterRows = database.db.prepare("SELECT project_id, token, ref_image_path FROM project_characters").all() as Array<Record<string, string>>;
    const updateCharacter = database.db.prepare("UPDATE project_characters SET ref_image_path = ? WHERE project_id = ? AND token = ?");
    for (const row of characterRows) {
      updateCharacter.run(rebasedPath(row.ref_image_path, mappings), row.project_id, row.token);
    }
    updateJsonColumn(database, "visual_bibles", "id", "anchor_image_paths", mappings);
    updateJsonColumn(database, "style_presets", "id", "anchor_image_paths", mappings);
  });
}

export async function finishStorageMigration(
  layout: StorageLayout,
  migration: StorageMigrationResult,
): Promise<string[]> {
  if (!migration.migrated) return [];
  const cleanupErrors: string[] = [];
  for (const source of migration.sources) {
    const resolvedSource = resolve(source.sourcePath);
    if (resolvedSource === dirname(resolvedSource) || samePath(source.sourcePath, source.targetPath)) continue;
    try {
      await rm(resolvedSource, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`${resolvedSource}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const markerPath = join(layout.dataRoot, "storage-migration.json");
  await writeFile(markerPath, JSON.stringify({
    version: 1,
    completedAt: new Date().toISOString(),
    root: layout.root,
    copiedFiles: migration.copiedFiles,
    copiedBytes: migration.copiedBytes,
    sources: migration.sources,
    cleanupErrors,
  }, null, 2), "utf8");
  return cleanupErrors;
}
