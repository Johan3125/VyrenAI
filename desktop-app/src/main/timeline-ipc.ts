import { BrowserWindow, ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  MAX_TIMELINE_FILE_BYTES,
  PROMPT_POLICY_REWRITE_CHANNEL,
  TIMELINE_CANCEL_CHANNEL,
  TIMELINE_GENERATE_CHANNEL,
  TIMELINE_PROGRESS_CHANNEL,
  normalizeVisualBible,
  normalizeStyleReference,
  type TimelineGenerateInput,
  type PolicyPromptRewriteInput,
  type TimelineProgress,
} from "../shared/timeline";
import {
  PROMPT_FILE_IMPORT_CHANNEL,
  detectLocalPromptFilePath,
  importPromptFileText,
} from "../shared/prompt-file";
import { normalizeCharacterToken } from "../shared/character";
import { normalizeTextProvider } from "../shared/provider";
import { WorkerServer } from "./worker-server";

function validateText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} không được để trống`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TIMELINE_FILE_BYTES) {
    throw new Error(`${label} vượt quá giới hạn 2 MB`);
  }
  return value;
}

function validateInput(value: unknown): TimelineGenerateInput {
  if (!value || typeof value !== "object") {
    throw new Error("Dữ liệu timeline không hợp lệ");
  }
  const input = value as Record<string, unknown>;
  const srtText = validateText(input.srtText, "File phụ đề");
  if (!/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(srtText)) {
    throw new Error("File phụ đề không chứa timestamp SRT hợp lệ");
  }

  const characterRoster = Array.isArray(input.characterRoster)
    ? input.characterRoster.slice(0, 100).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const source = entry as Record<string, unknown>;
      const token = typeof source.token === "string"
        ? normalizeCharacterToken(source.token)
        : null;
      const name = typeof source.name === "string" ? source.name.trim().slice(0, 80) : "";
      return token && name ? [{ token, name }] : [];
    })
    : [];
  const visualBible = normalizeVisualBible(input.visualBible);
  const outputTarget = input.outputTarget === "prompts" ||
    input.outputTarget === "images" ||
    input.outputTarget === "video"
    ? input.outputTarget
    : "video";
  const videoSourceMode = input.videoSourceMode === "direct" ||
    input.videoSourceMode === "image-first"
    ? input.videoSourceMode
    : outputTarget === "video"
      ? "direct"
      : undefined;

  return {
    textProvider: normalizeTextProvider(input.textProvider),
    outputTarget,
    videoSourceMode,
    srtText,
    scriptText: validateText(input.scriptText, "File kịch bản"),
    visualBible,
    characterRoster,
    styleReference: normalizeStyleReference(input.styleReference),
  };
}

async function importPromptFile(value: unknown) {
  const filePath = typeof value === "string" ? detectLocalPromptFilePath(value) : null;
  if (!filePath) {
    throw new Error("Đường dẫn prompt file không hợp lệ. Hãy dùng file .txt hoặc .md với đường dẫn tuyệt đối.");
  }
  const extension = extname(filePath).toLowerCase();
  if (extension !== ".txt" && extension !== ".md") {
    throw new Error("Prompt file phải có định dạng .txt hoặc .md");
  }
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error("Đường dẫn prompt không trỏ tới một file.");
  }
  if (info.size > MAX_TIMELINE_FILE_BYTES) {
    throw new Error("Prompt file vượt quá giới hạn 2 MB.");
  }
  const text = await readFile(filePath, "utf8");
  return importPromptFileText(text, {
    sourceName: basename(filePath),
    sourcePath: filePath,
  });
}

function validatePolicyRewriteInput(value: unknown): PolicyPromptRewriteInput {
  if (!value || typeof value !== "object") {
    throw new Error("Dữ liệu sửa prompt không hợp lệ");
  }
  const input = value as Record<string, unknown>;
  const sceneId = typeof input.sceneId === "string" ? input.sceneId.trim() : "";
  const mediaType = input.mediaType === "video" ? "video" : input.mediaType === "image" ? "image" : null;
  if (!/^scene-\d{3,4}$/.test(sceneId) || !mediaType) {
    throw new Error("Scene hoặc loại prompt cần sửa không hợp lệ");
  }
  const text = (field: string, maxLength: number, required = true) => {
    const result = typeof input[field] === "string" ? input[field].trim() : "";
    if (required && !result) throw new Error(`${field} không được để trống`);
    return result.slice(0, maxLength);
  };
  return {
    textProvider: normalizeTextProvider(input.textProvider),
    sceneId,
    mediaType,
    prompt: text("prompt", 20_000),
    policyError: text("policyError", 2_000, false) || "Google Flow policy violation",
    timeStart: text("timeStart", 32),
    timeEnd: text("timeEnd", 32),
    pairedPrompt: text("pairedPrompt", 20_000, false),
    visualBible: normalizeVisualBible(input.visualBible),
    policyFlag: ["real_person", "violence", "weapons", "dangerous_activity", "sexual_content", "child_safety", "copyrighted_character"].includes(String(input.policyFlag || ""))
      ? input.policyFlag as PolicyPromptRewriteInput["policyFlag"]
      : null,
  };
}

function broadcastProgress(progress: TimelineProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(TIMELINE_PROGRESS_CHANNEL, progress);
  }
}

export function registerTimelineIpcHandlers(server: WorkerServer): void {
  ipcMain.handle(PROMPT_FILE_IMPORT_CHANNEL, (_event, value: unknown) =>
    importPromptFile(value),
  );
  ipcMain.handle(TIMELINE_GENERATE_CHANNEL, async (_event, value: unknown) => {
    let jobId = "timeline";
    const forwardProgress = (progress: TimelineProgress) => {
      jobId = progress.jobId || jobId;
      broadcastProgress(progress);
    };
    try {
      const result = await server.generateTimeline(validateInput(value), forwardProgress);
      broadcastProgress({ jobId, status: "succeeded", message: `Đã hoàn tất ${result.scenes.length} scene và prompt.` });
      return result;
    } catch (error) {
      broadcastProgress({
        jobId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
  ipcMain.handle(PROMPT_POLICY_REWRITE_CHANNEL, (_event, value: unknown) =>
    server.rewritePolicyPrompt(validatePolicyRewriteInput(value), broadcastProgress),
  );
  ipcMain.handle(TIMELINE_CANCEL_CHANNEL, () =>
    server.stopActiveTimelineJob(),
  );
}
