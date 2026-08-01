import { ipcMain } from "electron";
import {
  VISUAL_STYLE_DELETE_CHANNEL,
  VISUAL_STYLE_LIST_CHANNEL,
  VISUAL_STYLE_SAVE_CHANNEL,
  type GraphicStyleSaveInput,
} from "../shared/visual-style";
import type { VisualStyleStore } from "./visual-style-store";

export function registerVisualStyleIpcHandlers(store: VisualStyleStore): void {
  ipcMain.handle(VISUAL_STYLE_LIST_CHANNEL, () => store.list());
  ipcMain.handle(VISUAL_STYLE_SAVE_CHANNEL, (_event, input: GraphicStyleSaveInput) => store.save(input));
  ipcMain.handle(VISUAL_STYLE_DELETE_CHANNEL, (_event, id: string) => store.remove(id));
}

