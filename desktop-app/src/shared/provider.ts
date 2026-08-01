import {
  DEFAULT_VOICE_PROVIDER,
  normalizeVoiceProvider,
  type VoiceProvider,
} from "./voice";

export const PROVIDER_SETTINGS_GET_CHANNEL = "provider-settings:get";
export const PROVIDER_SETTINGS_SAVE_CHANNEL = "provider-settings:save";

export const TEXT_PROVIDERS = ["chatgpt", "claude", "gemini", "grok"] as const;
export const TRANSCRIPTION_PROVIDERS = ["none", "gemini-web", "grok-web", "api", "local"] as const;
export const PROVIDER_IMAGE_PROVIDERS = ["google-flow", "chatgpt-image", "grok-image", "gemini-image"] as const;
export const PROVIDER_VIDEO_PROVIDERS = ["google-flow", "grok-video", "gemini-video", "capcut-video"] as const;

export type TextProvider = (typeof TEXT_PROVIDERS)[number];
export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];
export type ProviderImageProvider = (typeof PROVIDER_IMAGE_PROVIDERS)[number];
export type ProviderVideoProvider = (typeof PROVIDER_VIDEO_PROVIDERS)[number];

export const TEXT_PROVIDER_WORKER_ROLE = {
  chatgpt: "chat-worker",
  claude: "claude-worker",
  gemini: "gemini-worker",
  grok: "grok-worker",
} as const;

export const TEXT_PROVIDER_LABEL = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
} as const;

export const IMAGE_PROVIDER_WORKER_ROLE = {
  "google-flow": "flow-worker",
  "chatgpt-image": "chat-worker",
  "gemini-image": "gemini-worker",
  "grok-image": "grok-worker",
} as const;

export const VIDEO_PROVIDER_WORKER_ROLE = {
  "google-flow": "flow-worker",
  "gemini-video": "gemini-worker",
  "grok-video": "grok-worker",
  "capcut-video": "capcut-worker",
} as const;

export const IMAGE_PROVIDER_LABEL = {
  "google-flow": "Google Flow",
  "chatgpt-image": "ChatGPT Image",
  "gemini-image": "Gemini Image",
  "grok-image": "Grok Image",
} as const;

export const VIDEO_PROVIDER_LABEL = {
  "google-flow": "Google Flow",
  "gemini-video": "Gemini Video",
  "grok-video": "Grok Video",
  "capcut-video": "CapCut Video Studio",
} as const;

export const IMAGE_PROVIDER_URL = {
  "google-flow": "https://labs.google/fx/tools/flow",
  "chatgpt-image": "https://chatgpt.com/",
  "gemini-image": "https://gemini.google.com/app",
  "grok-image": "https://grok.com/imagine",
} as const;

export const VIDEO_PROVIDER_URL = {
  "google-flow": "https://labs.google/fx/tools/flow",
  "gemini-video": "https://gemini.google.com/app",
  "grok-video": "https://grok.com/imagine",
  "capcut-video": "https://www.capcut.com/ai-creator/start",
} as const;

export interface ProviderSettings {
  textProvider: TextProvider;
  transcriptionProvider: TranscriptionProvider;
  imageProvider: ProviderImageProvider;
  videoProvider: ProviderVideoProvider;
  voiceProvider: VoiceProvider;
  updatedAt: string;
}

export type ProviderSettingsInput = Partial<Omit<ProviderSettings, "updatedAt">>;

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  textProvider: "chatgpt",
  transcriptionProvider: "none",
  imageProvider: "google-flow",
  videoProvider: "google-flow",
  voiceProvider: DEFAULT_VOICE_PROVIDER,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export interface ProviderSettingsBridge {
  get: () => Promise<ProviderSettings>;
  save: (input: ProviderSettingsInput) => Promise<ProviderSettings>;
}

function includes<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function normalizeTextProvider(value: unknown): TextProvider {
  return includes(TEXT_PROVIDERS, value)
    ? value
    : DEFAULT_PROVIDER_SETTINGS.textProvider;
}

export function normalizeProviderSettings(value: unknown): ProviderSettings {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    textProvider: normalizeTextProvider(source.textProvider),
    transcriptionProvider: includes(TRANSCRIPTION_PROVIDERS, source.transcriptionProvider)
      ? source.transcriptionProvider
      : DEFAULT_PROVIDER_SETTINGS.transcriptionProvider,
    imageProvider: includes(PROVIDER_IMAGE_PROVIDERS, source.imageProvider)
      ? source.imageProvider
      : DEFAULT_PROVIDER_SETTINGS.imageProvider,
    videoProvider: includes(PROVIDER_VIDEO_PROVIDERS, source.videoProvider)
      ? source.videoProvider
      : DEFAULT_PROVIDER_SETTINGS.videoProvider,
    voiceProvider: normalizeVoiceProvider(source.voiceProvider),
    updatedAt: typeof source.updatedAt === "string"
      ? source.updatedAt
      : DEFAULT_PROVIDER_SETTINGS.updatedAt,
  };
}
