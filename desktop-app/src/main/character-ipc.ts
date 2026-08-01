import { ipcMain } from "electron";
import {
  CHARACTER_CREATE_CHANNEL,
  CHARACTER_DELETE_CHANNEL,
  CHARACTER_LIST_CHANNEL,
  CHARACTER_UPDATE_CHANNEL,
  type CharacterCreateInput,
  type CharacterUpdateInput,
} from "../shared/character";
import type { CharacterStore } from "./character-store";

export function registerCharacterIpcHandlers(store: CharacterStore): void {
  ipcMain.handle(CHARACTER_LIST_CHANNEL, () => store.listViews());

  ipcMain.handle(
    CHARACTER_CREATE_CHANNEL,
    async (_event, input: CharacterCreateInput) => {
      await store.create(input);
      return store.listViews();
    },
  );

  ipcMain.handle(
    CHARACTER_UPDATE_CHANNEL,
    async (_event, input: CharacterUpdateInput) => {
      await store.update(input);
      return store.listViews();
    },
  );

  ipcMain.handle(CHARACTER_DELETE_CHANNEL, async (_event, token: string) => {
    await store.remove(token);
    return store.listViews();
  });
}

