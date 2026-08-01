import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { join } from "node:path";
import {
  WORKER_STATUS_CHANNEL,
  WORKER_STATUS_GET_CHANNEL,
  type WorkerStatuses,
} from "../shared/worker-status";
import { registerCharacterIpcHandlers } from "./character-ipc";
import { CharacterStore } from "./character-store";
import { registerTimelineIpcHandlers } from "./timeline-ipc";
import { registerTimelineSessionIpcHandlers } from "./timeline-session-ipc";
import { TimelineSessionStore } from "./timeline-session-store";
import { registerSceneJobIpcHandlers } from "./scene-job-ipc";
import { registerMediaIpcHandlers, registerMediaProtocol } from "./media-ipc";
import { registerVisualStyleIpcHandlers } from "./visual-style-ipc";
import { VisualStyleStore } from "./visual-style-store";
import { ProjectDatabase } from "./project-database";
import { migrateLegacyProjectData } from "./legacy-project-migration";
import { ProductionQueue } from "./production-queue";
import { registerProductionQueueIpcHandlers } from "./production-queue-ipc";
import { ProjectRepositories } from "./project-repositories";
import { reconcileTimelineSessionsFromProjects, recoverLegacySessionFromProject } from "./legacy-session-recovery";
import { QUEUE_CHANGED_CHANNEL, type ProductionQueueSnapshot } from "../shared/production-queue";
import {
  APP_BRAND_NAME,
  APP_ID,
  EXTENSION_RESOURCE_DIR,
  STORAGE_FOLDER_NAME,
} from "../shared/brand";
import {
  WORKER_SERVER_HOST,
  WORKER_SERVER_PORT,
  WorkerServer,
} from "./worker-server";
import { VOICE_PROGRESS_CHANNEL, type VoiceProgress } from "../shared/voice";
import { VoiceService } from "./voice-service";
import { registerVoiceIpcHandlers } from "./voice-ipc";
import { registerSystemIpcHandlers } from "./system-ipc";
import { registerCapCutIpcHandlers } from "./capcut-ipc";
import { CapCutService } from "./capcut-service";
import { EditService } from "./edit-service";
import { registerEditIpcHandlers } from "./edit-ipc";
import { registerProviderSettingsIpcHandlers } from "./provider-settings-ipc";
import { ProviderSettingsStore } from "./provider-settings-store";
import {
  finishStorageMigration,
  prepareStorage,
  readStoragePreference,
  rebaseProjectDatabasePaths,
  resolveStorageLayout,
  writeStoragePreference,
} from "./storage-manager";

let workerServer: WorkerServer | null = null;
let projectDatabase: ProjectDatabase | null = null;
let productionQueue: ProductionQueue | null = null;
let voiceService: VoiceService | null = null;
const VYREN_APP_USER_MODEL_ID = APP_ID;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

protocol.registerSchemesAsPrivileged([{ scheme: "vyren-media", privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true } }]);

function broadcastWorkerStatuses(statuses: WorkerStatuses): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(WORKER_STATUS_CHANNEL, statuses);
  }
}

function broadcastQueueSnapshot(snapshot: ProductionQueueSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(QUEUE_CHANGED_CHANNEL, snapshot);
  }
}

function broadcastVoiceProgress(progress: VoiceProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(VOICE_PROGRESS_CHANNEL, progress);
  }
}

function createWindow(): void {
  const icon = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(__dirname, "../../build/icon.png");
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#07111F",
    title: APP_BRAND_NAME,
    icon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId(VYREN_APP_USER_MODEL_ID);
  const legacyUserDataRoot = app.getPath("userData");
  const legacyOutputRoot = join(app.getPath("downloads"), STORAGE_FOLDER_NAME);
  const storagePreferencePath = join(legacyUserDataRoot, "storage-location.json");
  const storagePreference = await readStoragePreference(storagePreferencePath);
  const storage = resolveStorageLayout({
    environmentRoot: process.env.VYREN_AI_STORAGE_ROOT || process.env.KC_AUTO_TOOL_STORAGE_ROOT || storagePreference?.rootPath,
    flowxDataRoot: process.env.VYREN_AI_DATA_DIR || process.env.FLOWX_DATA_DIR,
    documentsRoot: app.getPath("documents"),
  });
  let migration;
  try {
    migration = await prepareStorage(storage, {
      legacyUserDataRoot,
      legacyOutputRoot,
      previousStorageRoot: process.env.KC_AUTO_TOOL_STORAGE_ROOT ? undefined : storagePreference?.previousRootPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${APP_BRAND_NAME}] Storage migration failed:`, error);
    dialog.showErrorBox(`${APP_BRAND_NAME} storage migration failed`, `Không thể chuyển dữ liệu sang ${storage.root}.\n\n${message}`);
    app.quit();
    return;
  }
  const timelineSessionStore = new TimelineSessionStore(
    join(storage.dataRoot, "timeline-session"),
  );
  const characterStore = new CharacterStore(
    join(storage.dataRoot, "character-library"),
  );
  const visualStyleStore = new VisualStyleStore(
    join(storage.dataRoot, "visual-style-library"),
  );
  const providerSettingsStore = new ProviderSettingsStore(
    join(storage.dataRoot, "provider-settings"),
  );
  projectDatabase = new ProjectDatabase(
    join(storage.dataRoot, "project-database", "flowx.sqlite"),
  );
  const configuredWorkerPort = Number.parseInt(
    process.env.FLOWX_WORKER_PORT || "",
    10,
  );
  const workerServerOptions =
    Number.isInteger(configuredWorkerPort) &&
    configuredWorkerPort > 0 &&
    configuredWorkerPort <= 65_535
      ? { port: configuredWorkerPort }
      : {};
  workerServer = new WorkerServer(broadcastWorkerStatuses, workerServerOptions);
  ipcMain.handle(WORKER_STATUS_GET_CHANNEL, () => workerServer?.getStatuses());

  try {
    await characterStore.initialize();
    await timelineSessionStore.initialize();
    await visualStyleStore.initialize();
    await providerSettingsStore.initialize();
    await projectDatabase.initialize();
    rebaseProjectDatabasePaths(projectDatabase, migration.pathMappings);
    const storageCleanupErrors = await finishStorageMigration(storage, migration);
    if (storageCleanupErrors.length) {
      console.warn(`[${APP_BRAND_NAME}] Dữ liệu đã chuyển sang ổ mới nhưng một số bản cũ đang bị khóa:`, storageCleanupErrors);
    } else if (storagePreference?.previousRootPath) {
      await writeStoragePreference(storagePreferencePath, storage.root);
    }
    const recoveredSession = await recoverLegacySessionFromProject(
      projectDatabase,
      timelineSessionStore,
    );
    const reconciledSessions = await reconcileTimelineSessionsFromProjects(
      projectDatabase,
      timelineSessionStore,
    );
    if (reconciledSessions.length) {
      console.warn(`[${APP_BRAND_NAME}] Đã tự khôi phục Timeline cho ${reconciledSessions.length} phiên từ Production Database.`);
    }
    const legacyMigration = migrateLegacyProjectData(
      projectDatabase,
      await timelineSessionStore.load(),
      await visualStyleStore.list(),
      await characterStore.list(),
      { initialImportOnly: true },
    );
    registerCharacterIpcHandlers(characterStore);
    registerVisualStyleIpcHandlers(visualStyleStore);
    registerProviderSettingsIpcHandlers(providerSettingsStore, (settings) => {
      productionQueue?.setDefaultProviders(settings.imageProvider, settings.videoProvider);
    });
    await workerServer.start();
    const providerSettings = await providerSettingsStore.get();
    productionQueue = new ProductionQueue(
      projectDatabase,
      workerServer,
      characterStore,
      timelineSessionStore,
      broadcastQueueSnapshot,
      {
        generatedMediaRoot: storage.outputRoot,
        getTextProvider: async () => (await providerSettingsStore.get()).textProvider,
        defaultImageProvider: providerSettings.imageProvider,
        defaultVideoProvider: providerSettings.videoProvider,
      },
    );
    await productionQueue.start();
    registerProductionQueueIpcHandlers(productionQueue);
    voiceService = new VoiceService(
      storage.outputRoot,
      broadcastVoiceProgress,
    );
    registerVoiceIpcHandlers(voiceService);
    registerSystemIpcHandlers(
      storage,
      app.isPackaged
        ? join(process.resourcesPath, EXTENSION_RESOURCE_DIR)
        : join(__dirname, "../../../extension-worker"),
      storagePreferencePath,
    );
    registerCapCutIpcHandlers(new CapCutService(storage.backupRoot));
    registerEditIpcHandlers(new EditService(storage.outputRoot));
    registerTimelineSessionIpcHandlers(timelineSessionStore, {
      beforeDelete: (id) => {
        const snapshot = productionQueue?.getSnapshot(id);
        if (snapshot?.activeJobId || (snapshot?.activeJobs?.length || 0) > 0) {
          throw new Error("Phiên vẫn còn công việc đang chạy. Hãy dừng hàng đợi và thử lại.");
        }
      },
      afterDelete: (id) => {
        if (!projectDatabase) return;
        new ProjectRepositories(projectDatabase).projects.remove(id);
      },
      afterRename: (id, name) => {
        if (!projectDatabase) return;
        const projects = new ProjectRepositories(projectDatabase).projects;
        if (projects.get(id)) projects.rename(id, name);
      },
    });
    registerTimelineIpcHandlers(workerServer);
    registerSceneJobIpcHandlers(workerServer, characterStore, storage.outputRoot);
    registerMediaIpcHandlers(storage.outputRoot);
    registerMediaProtocol(storage.outputRoot);
    console.info(
      `[Vyren AI] Project DB schema v${projectDatabase.schemaVersion}; legacy migration: ${legacyMigration.migrated ? `${legacyMigration.sceneCount} scenes` : "up to date"}`,
    );
    if (recoveredSession) {
      console.info(`[Vyren AI] Recovered ${recoveredSession.scenes.length} scenes from the legacy SQLite project.`);
    }
    console.info(
      `[Vyren AI] Worker server listening on ws://${WORKER_SERVER_HOST}:${workerServer.getListeningPort() || WORKER_SERVER_PORT}`,
    );
    console.info(`[Vyren AI] Storage root: ${storage.root}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${APP_BRAND_NAME}] Startup failed:`, error);
    dialog.showErrorBox(
      "Vyren AI startup failed",
      `Could not initialize local services.\n\n${message}`,
    );
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  voiceService?.cancel();
  productionQueue?.shutdown();
  workerServer?.stop();
  projectDatabase?.close();
});
