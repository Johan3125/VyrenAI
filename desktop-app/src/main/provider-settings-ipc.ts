import { ipcMain } from "electron";
import {
  PROVIDER_SETTINGS_GET_CHANNEL,
  PROVIDER_SETTINGS_SAVE_CHANNEL,
  type ProviderSettings,
  type ProviderSettingsInput,
} from "../shared/provider";
import type { ProviderSettingsStore } from "./provider-settings-store";

export function registerProviderSettingsIpcHandlers(
  store: ProviderSettingsStore,
  onSaved: (settings: ProviderSettings) => void = () => {},
): void {
  ipcMain.handle(PROVIDER_SETTINGS_GET_CHANNEL, () => store.get());
  ipcMain.handle(
    PROVIDER_SETTINGS_SAVE_CHANNEL,
    async (_event, input: ProviderSettingsInput) => {
      const settings = await store.save(input || {});
      onSaved(settings);
      return settings;
    },
  );
}
