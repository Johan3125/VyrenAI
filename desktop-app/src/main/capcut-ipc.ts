import { ipcMain } from "electron";
import {
  CAPCUT_BUILD_TIMELINE_CHANNEL,
  CAPCUT_INSPECT_BUILD_CHANNEL,
  type CapCutAudioMode,
  type CapCutBuildOptions,
} from "../shared/capcut";
import type { TimelineSession } from "../shared/timeline";
import { CapCutService } from "./capcut-service";

export function registerCapCutIpcHandlers(service: CapCutService): void {
  ipcMain.handle(
    CAPCUT_INSPECT_BUILD_CHANNEL,
    (_event, value: { session: TimelineSession; targetProjectPath?: string; audioMode?: CapCutAudioMode }) =>
      service.inspect(value?.session, value?.targetProjectPath, value?.audioMode),
  );
  ipcMain.handle(
    CAPCUT_BUILD_TIMELINE_CHANNEL,
    (_event, value: { session: TimelineSession; options: CapCutBuildOptions }) =>
      service.build(value?.session, value?.options),
  );
}
