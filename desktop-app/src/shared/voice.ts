export const VOICE_LIST_CHANNEL = "voice:list";
export const VOICE_PREVIEW_CHANNEL = "voice:preview";
export const VOICE_GENERATE_CHANNEL = "voice:generate";
export const VOICE_CANCEL_CHANNEL = "voice:cancel";
export const VOICE_PROGRESS_CHANNEL = "voice:progress";
export const VOICE_IMPORT_AUDIO_CHANNEL = "voice:import-audio";
export const VOICE_IMPORT_SUBTITLES_CHANNEL = "voice:import-subtitles";

export type VoicePauseLevel = "off" | "medium" | "strong" | "dramatic";
export const VOICE_PROVIDERS = ["edge", "capcut-web", "imported"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export const DEFAULT_VOICE_PROVIDER: VoiceProvider = "edge";

export const VOICE_PROVIDER_LABEL: Record<VoiceProvider, string> = {
  edge: "Microsoft Edge TTS",
  "capcut-web": "CapCut Voice Web",
  imported: "Import MP3/SRT",
};

export function normalizeVoiceProvider(value: unknown): VoiceProvider {
  return typeof value === "string" && (VOICE_PROVIDERS as readonly string[]).includes(value)
    ? value as VoiceProvider
    : DEFAULT_VOICE_PROVIDER;
}

export interface VoiceCatalogEntry {
  provider?: VoiceProvider;
  shortName: string;
  locale: string;
  gender: string;
  friendlyName: string;
}

export interface VoiceProsody {
  rate: number;
  pitch: number;
  volume: number;
  pauseLevel: VoicePauseLevel;
}

export interface VoiceGenerateInput {
  provider?: VoiceProvider;
  projectId: string;
  projectName: string;
  narrationText: string;
  narrationFileName: string;
  voice: string;
  prosody: VoiceProsody;
  splitMode?: "paragraph" | "sentence";
  maxCharsPerChunk?: number;
  exportWordSrt?: boolean;
}

export interface VoiceWordTiming {
  text: string;
  start: number;
  end: number;
}

export interface VoiceGenerateResult {
  audioPath: string;
  audioFileName: string;
  srtPath: string;
  srtFileName: string;
  srtText: string;
  wordSrtPath: string;
  wordSrtFileName: string;
  durationSeconds: number;
  words: VoiceWordTiming[];
}

export interface ImportedVoiceSubtitles {
  srtPath: string;
  srtFileName: string;
  srtText: string;
  transcript: string;
  cueCount: number;
  durationSeconds: number;
  warnings: string[];
}

export interface ImportedVoiceAudio {
  audioPath: string;
  audioFileName: string;
  sourceFileName: string;
  durationSeconds: number;
  sizeBytes: number;
  codec: string;
  bitRateKbps: number;
  sampleRateHz: number;
  channels: number;
  warnings: string[];
  subtitles: ImportedVoiceSubtitles | null;
}

export interface VoiceProgress {
  stage: "preparing" | "synthesizing" | "joining" | "pauses" | "subtitles" | "done" | "stopping";
  completed: number;
  total: number;
  message: string;
}

export interface VoiceBridge {
  list: (provider?: VoiceProvider) => Promise<VoiceCatalogEntry[]>;
  preview: (voice: string, locale: string, provider?: VoiceProvider) => Promise<string>;
  generate: (input: VoiceGenerateInput) => Promise<VoiceGenerateResult>;
  importAudio: (projectId: string) => Promise<ImportedVoiceAudio | null>;
  importSubtitles: (
    projectId: string,
    audioDurationSeconds: number,
  ) => Promise<ImportedVoiceSubtitles | null>;
  cancel: () => Promise<boolean>;
  onProgress: (callback: (progress: VoiceProgress) => void) => () => void;
}
