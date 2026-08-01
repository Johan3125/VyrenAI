import { dialog, ipcMain } from "electron";
import {
  VOICE_CANCEL_CHANNEL,
  VOICE_GENERATE_CHANNEL,
  VOICE_IMPORT_AUDIO_CHANNEL,
  VOICE_IMPORT_SUBTITLES_CHANNEL,
  VOICE_LIST_CHANNEL,
  VOICE_PREVIEW_CHANNEL,
  type VoiceGenerateInput,
  type VoiceProvider,
} from "../shared/voice";
import type { VoiceService } from "./voice-service";

export function registerVoiceIpcHandlers(service: VoiceService): void {
  ipcMain.handle(VOICE_LIST_CHANNEL, (_event, value?: { provider?: VoiceProvider }) =>
    service.listVoices(value?.provider),
  );
  ipcMain.handle(
    VOICE_PREVIEW_CHANNEL,
    (_event, value: { voice?: unknown; locale?: unknown; provider?: VoiceProvider }) => {
      const voice = typeof value?.voice === "string" ? value.voice.trim() : "";
      const locale = typeof value?.locale === "string" ? value.locale.trim() : "";
      if (!voice) throw new Error("Giọng nghe thử không hợp lệ.");
      return service.preview(voice, locale, value.provider);
    },
  );
  ipcMain.handle(
    VOICE_GENERATE_CHANNEL,
    (_event, value: VoiceGenerateInput) => service.generate(value),
  );
  ipcMain.handle(
    VOICE_IMPORT_AUDIO_CHANNEL,
    async (_event, value: { projectId?: unknown }) => {
      const projectId = typeof value?.projectId === "string" ? value.projectId.trim() : "";
      const selection = await dialog.showOpenDialog({
        title: "Chọn voice audio MP3",
        properties: ["openFile"],
        filters: [{ name: "MP3 voice audio", extensions: ["mp3"] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      return service.importAudio(projectId, selection.filePaths[0]);
    },
  );
  ipcMain.handle(
    VOICE_IMPORT_SUBTITLES_CHANNEL,
    async (
      _event,
      value: { projectId?: unknown; audioDurationSeconds?: unknown },
    ) => {
      const projectId = typeof value?.projectId === "string" ? value.projectId.trim() : "";
      const audioDurationSeconds = Number(value?.audioDurationSeconds);
      const selection = await dialog.showOpenDialog({
        title: "Chọn SRT đồng bộ với voice audio",
        properties: ["openFile"],
        filters: [{ name: "SubRip subtitles", extensions: ["srt"] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      return service.importSubtitles(
        projectId,
        selection.filePaths[0],
        audioDurationSeconds,
      );
    },
  );
  ipcMain.handle(VOICE_CANCEL_CHANNEL, () => service.cancel());
}
