import { BrowserWindow, ipcMain } from "electron";
import {
  SCENE_JOB_PROGRESS_CHANNEL,
  SCENE_JOB_CANCEL_CHANNEL,
  SCENE_JOB_RUN_CHANNEL,
  normalizeSceneJobInput,
  type SceneJobProgress,
} from "../shared/scene-job";
import { WorkerServer } from "./worker-server";
import type { CharacterStore } from "./character-store";
import { relocateSceneJobResult } from "./media-relocation";
import { resolveSceneSourceImage } from "./scene-source-image";

function broadcastProgress(progress: SceneJobProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(SCENE_JOB_PROGRESS_CHANNEL, progress);
  }
}

export function registerSceneJobIpcHandlers(
  server: WorkerServer,
  characterStore: CharacterStore,
  generatedMediaRoot?: string,
): void {
  ipcMain.handle(SCENE_JOB_CANCEL_CHANNEL, () =>
    server.stopActiveJob("flow-worker") ||
    server.stopActiveJob("chat-worker") ||
    server.stopActiveJob("gemini-worker") ||
    server.stopActiveJob("grok-worker") ||
    server.stopActiveJob("capcut-worker"));
  ipcMain.handle(SCENE_JOB_RUN_CHANNEL, async (_event, value: unknown) => {
    const input = normalizeSceneJobInput(value);
    const refImages = input.mediaType === "image"
      ? await characterStore.resolveReferences(input.characterTokens)
      : [];
    const sourceImage = input.mediaType === "video" &&
      input.videoSettings.provider !== "google-flow" &&
      input.videoSettings.mode !== "text-to-video"
      ? await resolveSceneSourceImage(input.sourceImagePath)
      : null;
    const result = await server.runSceneJob(
      { ...input, refImages, sourceImage },
      broadcastProgress,
    );
    return result.status === "submitted"
      ? result
      : generatedMediaRoot
      ? relocateSceneJobResult(result, generatedMediaRoot, input.outputFolder || "default-session")
      : result;
  });
}
