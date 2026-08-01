import { ipcMain } from "electron";
import {
  TIMELINE_SESSION_CLEAR_CHANNEL,
  TIMELINE_SESSION_CREATE_CHANNEL,
  TIMELINE_SESSION_DELETE_CHANNEL,
  TIMELINE_SESSION_LIST_CHANNEL,
  TIMELINE_SESSION_LOAD_CHANNEL,
  TIMELINE_SESSION_RENAME_CHANNEL,
  TIMELINE_SESSION_SAVE_CHANNEL,
  TIMELINE_SESSION_SELECT_CHANNEL,
  type TimelineSessionInput,
} from "../shared/timeline";
import type { TimelineSessionStore } from "./timeline-session-store";

export function registerTimelineSessionIpcHandlers(
  store: TimelineSessionStore,
  hooks: {
    beforeDelete?: (id: string) => void | Promise<void>;
    afterDelete?: (id: string) => void | Promise<void>;
    afterRename?: (id: string, name: string) => void | Promise<void>;
  } = {},
): void {
  ipcMain.handle(TIMELINE_SESSION_LOAD_CHANNEL, () => store.load());
  ipcMain.handle(TIMELINE_SESSION_LIST_CHANNEL, () => store.list());
  ipcMain.handle(TIMELINE_SESSION_CREATE_CHANNEL, (_event, name?: string) => store.create(name));
  ipcMain.handle(TIMELINE_SESSION_SELECT_CHANNEL, (_event, id: string) => store.select(id));
  ipcMain.handle(TIMELINE_SESSION_RENAME_CHANNEL, async (_event, value: { id: string; name: string }) => {
    const result = await store.rename(value?.id, value?.name);
    await hooks.afterRename?.(value?.id, value?.name);
    return result;
  });
  ipcMain.handle(TIMELINE_SESSION_DELETE_CHANNEL, async (_event, id: string) => {
    await hooks.beforeDelete?.(id);
    const result = await store.delete(id);
    await hooks.afterDelete?.(id);
    return result;
  });
  ipcMain.handle(
    TIMELINE_SESSION_SAVE_CHANNEL,
    (_event, input: TimelineSessionInput) => store.save(input),
  );
  ipcMain.handle(TIMELINE_SESSION_CLEAR_CHANNEL, () => store.clear());
}
