import { app, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  OUTPUT_INSPECT_CHANNEL,
  OUTPUT_EXPORT_SESSION_CHANNEL,
  OUTPUT_OPEN_CHANNEL,
  SYSTEM_OPEN_EXTENSION_FOLDER_CHANNEL,
  SYSTEM_OPEN_STORAGE_CHANNEL,
  SYSTEM_RESTART_CHANNEL,
  SYSTEM_SELECT_STORAGE_CHANNEL,
  SYSTEM_STATUS_CHANNEL,
  type OutputFileView,
  type OutputGroupId,
  type OutputGroupView,
  type OutputInspection,
  type SystemStatus,
} from "../shared/system";
import type { TimelineSession } from "../shared/timeline";
import {
  buildFlowSceneJsonList,
  buildGoogleFlowCsvExport,
  buildGoogleFlowMarkdownExport,
  buildGoogleFlowSrtExport,
  buildGoogleFlowTextExport,
} from "../shared/continuity";
import {
  APP_BRAND_NAME,
  EXTENSION_DISPLAY_NAME,
  STORAGE_FOLDER_NAME,
} from "../shared/brand";
import type { StorageLayout } from "./storage-manager";
import { writeStoragePreference } from "./storage-manager";

const GROUP_IDS: OutputGroupId[] = ["audio", "srt", "prompts", "images", "videos", "frames", "logs", "metadata"];
const execFileAsync = promisify(execFile);
let ffmpegStatusPromise: Promise<{ available: boolean; version: string }> | null = null;

function detectFfmpeg(): Promise<{ available: boolean; version: string }> {
  ffmpegStatusPromise ||= execFileAsync("ffmpeg", ["-version"], { windowsHide: true, timeout: 8_000 })
    .then(({ stdout }) => ({ available: true, version: String(stdout).split(/\r?\n/, 1)[0]?.trim() || "FFmpeg" }))
    .catch(() => ({ available: false, version: "" }));
  return ffmpegStatusPromise;
}

function projectId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
    throw new Error("Mã phiên đầu ra không hợp lệ.");
  }
  return id;
}

function safeProjectRoot(generatedRoot: string, value: unknown): string {
  const root = resolve(generatedRoot);
  const candidate = resolve(root, projectId(value));
  const relation = relative(root, candidate);
  if (!relation || relation.startsWith("..") || normalize(relation).includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Đường dẫn đầu ra nằm ngoài thư mục ${APP_BRAND_NAME}.`);
  }
  return candidate;
}

function classify(path: string): OutputGroupId | null {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const extension = extname(normalized);
  if (normalized.includes("/prompts/")) return "prompts";
  if (normalized.includes("/.kc-frames/") || normalized.includes("/final-frames/")) return "frames";
  if (normalized.includes("/audio/") && [".mp3", ".wav", ".m4a", ".aac", ".flac"].includes(extension)) return "audio";
  if (extension === ".srt" || extension === ".vtt") return "srt";
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(extension)) return "images";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(extension)) return "videos";
  if ([".log", ".txt"].includes(extension) && normalized.includes("/logs/")) return "logs";
  if ([".json", ".yaml", ".yml"].includes(extension)) return "metadata";
  return null;
}

async function walk(directory: string): Promise<OutputFileView[]> {
  const result: OutputFileView[] = [];
  const visit = async (path: string) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const info = await stat(entryPath).catch(() => null);
        if (info) result.push({
          name: entry.name,
          path: entryPath,
          sizeBytes: info.size,
          updatedAt: info.mtime.toISOString(),
        });
      }
    }
  };
  await visit(directory);
  return result;
}

export function registerSystemIpcHandlers(storage: StorageLayout, extensionRoot: string, preferencePath: string): void {
  const generatedMediaRoot = storage.outputRoot;
  ipcMain.handle(SYSTEM_STATUS_CHANNEL, async (): Promise<SystemStatus> => {
    const memory = process.getSystemMemoryInfo();
    const metrics = app.getAppMetrics();
    const cpuPercent = metrics.length
      ? metrics.reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage || 0), 0)
      : null;
    const disk = await statfs(generatedMediaRoot).catch(() => null);
    const ffmpeg = await detectFfmpeg();
    return {
      appVersion: app.getVersion(),
      cpuPercent,
      ramUsedBytes: Math.max(0, memory.total - memory.free) * 1_024,
      ramTotalBytes: memory.total * 1_024,
      gpuPercent: null,
      ffmpegAvailable: ffmpeg.available,
      ffmpegVersion: ffmpeg.version,
      diskFreeBytes: disk ? Number(disk.bavail) * Number(disk.bsize) : null,
      diskTotalBytes: disk ? Number(disk.blocks) * Number(disk.bsize) : null,
      storageRoot: storage.root,
      dataRoot: storage.dataRoot,
      outputRoot: storage.outputRoot,
      storageSource: storage.source,
      updatedAt: new Date().toISOString(),
    };
  });

  ipcMain.handle(SYSTEM_OPEN_EXTENSION_FOLDER_CHANNEL, async (): Promise<string> => {
    const info = await stat(extensionRoot).catch(() => null);
    if (!info?.isDirectory()) return `Không tìm thấy thư mục extension ${EXTENSION_DISPLAY_NAME} trong bộ cài.`;
    return shell.openPath(extensionRoot);
  });

  ipcMain.handle(SYSTEM_OPEN_STORAGE_CHANNEL, async (_event, value: unknown): Promise<string> => {
    const target = value === "data"
      ? storage.dataRoot
      : value === "outputs"
        ? storage.outputRoot
        : storage.root;
    await mkdir(target, { recursive: true });
    return shell.openPath(target);
  });

  ipcMain.handle(SYSTEM_SELECT_STORAGE_CHANNEL, async () => {
    const selection = await dialog.showOpenDialog({
      title: `Chọn thư mục cha để lưu dữ liệu ${APP_BRAND_NAME}`,
      defaultPath: dirname(storage.root),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Dùng thư mục này",
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return { selected: false, rootPath: storage.root, restartRequired: false };
    }
    const selected = resolve(selection.filePaths[0]);
    const rootPath = basename(selected).toLocaleLowerCase("en-US") === STORAGE_FOLDER_NAME.toLocaleLowerCase("en-US")
      ? selected
      : join(selected, STORAGE_FOLDER_NAME);
    const restartRequired = normalize(rootPath).toLocaleLowerCase("en-US") !== normalize(storage.root).toLocaleLowerCase("en-US");
    if (restartRequired) await writeStoragePreference(preferencePath, rootPath, storage.root);
    return { selected: true, rootPath, restartRequired };
  });

  ipcMain.handle(SYSTEM_RESTART_CHANNEL, () => {
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
  });

  ipcMain.handle(OUTPUT_INSPECT_CHANNEL, async (_event, value: unknown): Promise<OutputInspection> => {
    const id = projectId(value);
    const rootPath = safeProjectRoot(generatedMediaRoot, id);
    const files = await walk(rootPath);
    const groups: OutputGroupView[] = GROUP_IDS.map((groupId) => {
      const grouped = files.filter((file) => classify(file.path) === groupId);
      const defaultPath = groupId === "frames"
        ? join(rootPath, ".kc-frames")
        : groupId === "images" || groupId === "videos"
          ? rootPath
          : join(rootPath, groupId);
      return {
        id: groupId,
        count: grouped.length,
        sizeBytes: grouped.reduce((sum, file) => sum + file.sizeBytes, 0),
        path: grouped[0]?.path ? dirname(grouped[0].path) : defaultPath,
        files: grouped.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 60),
      };
    });
    return {
      projectId: id,
      rootPath,
      groups,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      scannedAt: new Date().toISOString(),
    };
  });

  ipcMain.handle(OUTPUT_EXPORT_SESSION_CHANNEL, async (_event, value: TimelineSession): Promise<OutputInspection> => {
    const rootPath = safeProjectRoot(generatedMediaRoot, value?.id);
    const metadataDirectory = join(rootPath, "metadata");
    const visualBibleDirectory = join(rootPath, "visual-bible");
    const promptDirectory = join(rootPath, "prompts");
    await Promise.all([metadataDirectory, visualBibleDirectory, promptDirectory].map((path) => mkdir(path, { recursive: true })));
    const scenes = Array.isArray(value?.scenes) ? value.scenes : [];
    const metadata = {
      id: value.id,
      name: String(value.name || APP_BRAND_NAME).slice(0, 160),
      createdAt: value.createdAt,
      savedAt: value.savedAt,
      workflowMode: value.workflowMode,
      sceneCount: scenes.length,
      source: value.workflowSource,
      styleReference: value.styleReference
        ? { name: value.styleReference.name, mimeType: value.styleReference.mimeType }
        : null,
    };
    const continuityScenes = buildFlowSceneJsonList(value);
    const prompts = continuityScenes.map((scene) => ({
      id: scene.sceneId,
      order: scene.sceneNumber,
      timeStart: scene.timeStart,
      timeEnd: scene.timeEnd,
      durationSeconds: scene.durationSeconds,
      chainId: scene.chainId,
      chainRole: scene.chainRole,
      startingFrameSource: scene.startingFrameSource,
      startingState: scene.startingState,
      primaryMotion: scene.primaryMotion,
      reaction: scene.reaction,
      environmentalMotion: scene.environmentalMotion,
      cameraMotion: scene.cameraMotion,
      endFrame: scene.endFrame,
      imagePrompt: scene.imagePrompt,
      videoPrompt: scene.videoPrompt,
      negativePrompt: scene.negativePrompt,
      characterTokens: scene.characterIds,
      referenceImageIds: scene.referenceImageIds,
      continuityWarnings: scene.continuityWarnings,
      status: scene.status,
    }));
    await Promise.all([
      writeFile(join(metadataDirectory, "project.json"), JSON.stringify(metadata, null, 2), "utf8"),
      writeFile(join(visualBibleDirectory, "visual-bible.json"), JSON.stringify(value.visualBible || {}, null, 2), "utf8"),
      writeFile(join(promptDirectory, "scenes.json"), JSON.stringify(prompts, null, 2), "utf8"),
      writeFile(join(promptDirectory, "continuity-scenes.json"), JSON.stringify(continuityScenes, null, 2), "utf8"),
      writeFile(join(promptDirectory, "google-flow-prompts.txt"), buildGoogleFlowTextExport(value), "utf8"),
      writeFile(join(promptDirectory, "google-flow-prompts.md"), buildGoogleFlowMarkdownExport(value), "utf8"),
      writeFile(join(promptDirectory, "google-flow-scenes.csv"), buildGoogleFlowCsvExport(value), "utf8"),
      writeFile(join(promptDirectory, "google-flow-scenes.srt"), buildGoogleFlowSrtExport(value), "utf8"),
    ]);
    const files = await walk(rootPath);
    const groups = GROUP_IDS.map((groupId) => {
      const grouped = files.filter((file) => classify(file.path) === groupId);
      return {
        id: groupId,
        count: grouped.length,
        sizeBytes: grouped.reduce((sum, file) => sum + file.sizeBytes, 0),
        path: grouped[0] ? dirname(grouped[0].path) : join(rootPath, groupId),
        files: grouped.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 60),
      };
    });
    return {
      projectId: value.id,
      rootPath,
      groups,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      scannedAt: new Date().toISOString(),
    };
  });

  ipcMain.handle(
    OUTPUT_OPEN_CHANNEL,
    async (_event, value: { projectId?: unknown; group?: unknown }): Promise<string> => {
      const rootPath = safeProjectRoot(generatedMediaRoot, value?.projectId);
      const group = GROUP_IDS.includes(value?.group as OutputGroupId)
        ? value.group as OutputGroupId
        : null;
      const actualFile = group
        ? (await walk(rootPath)).find((file) => classify(file.path) === group)
        : null;
      const target = actualFile
        ? dirname(actualFile.path)
        : !group || group === "images" || group === "videos"
          ? rootPath
          : group === "frames"
            ? join(rootPath, ".kc-frames")
            : join(rootPath, group);
      const error = await shell.openPath(target);
      return error;
    },
  );
}
