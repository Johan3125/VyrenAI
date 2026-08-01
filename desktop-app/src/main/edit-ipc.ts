import { BrowserWindow, dialog, ipcMain } from "electron";
import { EDIT_EXPORT_CHANNEL, EDIT_LOAD_CHANNEL, EDIT_PICK_VIDEO_CHANNEL, EDIT_SAVE_CHANNEL, EDIT_SYNC_CHANNEL, type EditExportOptions, type EditProject } from "../shared/edit";
import { EDIT_ASSEMBLY_CANCEL_CHANNEL, EDIT_ASSEMBLY_PROGRESS_CHANNEL, EDIT_ASSEMBLY_START_CHANNEL, EDIT_ASSEMBLY_VALIDATE_CHANNEL, type VideoAssemblySettings } from "../shared/video-assembly";
import type { TimelineSession } from "../shared/timeline";
import { EditService } from "./edit-service";

export function registerEditIpcHandlers(service: EditService): void {
  service.onAssemblyProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EDIT_ASSEMBLY_PROGRESS_CHANNEL, progress);
  });
  ipcMain.handle(EDIT_LOAD_CHANNEL, (_event, session: TimelineSession) => service.load(session));
  ipcMain.handle(EDIT_SYNC_CHANNEL, (_event, session: TimelineSession) => service.sync(session));
  ipcMain.handle(EDIT_SAVE_CHANNEL, (_event, project: EditProject) => service.save(project));
  ipcMain.handle(EDIT_EXPORT_CHANNEL, (_event, value: { project: EditProject; options: EditExportOptions }) => service.export(value.project, value.options));
  ipcMain.handle(EDIT_PICK_VIDEO_CHANNEL, async (_event, sessionId: string) => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Video", extensions: ["mp4", "webm", "mov", "mkv"] }] });
    const selectedPath = result.canceled ? null : result.filePaths[0] || null;
    return selectedPath ? service.importVideo(sessionId, selectedPath) : null;
  });
  ipcMain.handle(EDIT_ASSEMBLY_VALIDATE_CHANNEL, (_event, value: { project: EditProject; settings: VideoAssemblySettings }) => service.validateAssembly(value.project, value.settings));
  ipcMain.handle(EDIT_ASSEMBLY_START_CHANNEL, (_event, value: { project: EditProject; settings: VideoAssemblySettings }) => service.startAssembly(value.project, value.settings));
  ipcMain.handle(EDIT_ASSEMBLY_CANCEL_CHANNEL, (_event, jobId: string) => service.cancelAssembly(jobId));
}
