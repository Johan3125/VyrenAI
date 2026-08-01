import { contextBridge, ipcRenderer } from "electron";
import {
  TIMELINE_CANCEL_CHANNEL,
  TIMELINE_GENERATE_CHANNEL,
  PROMPT_POLICY_REWRITE_CHANNEL,
  TIMELINE_PROGRESS_CHANNEL,
  TIMELINE_SESSION_CLEAR_CHANNEL,
  TIMELINE_SESSION_CREATE_CHANNEL,
  TIMELINE_SESSION_DELETE_CHANNEL,
  TIMELINE_SESSION_LIST_CHANNEL,
  TIMELINE_SESSION_LOAD_CHANNEL,
  TIMELINE_SESSION_RENAME_CHANNEL,
  TIMELINE_SESSION_SAVE_CHANNEL,
  TIMELINE_SESSION_SELECT_CHANNEL,
  type TimelineProgress,
} from "../shared/timeline";
import { PROMPT_FILE_IMPORT_CHANNEL } from "../shared/prompt-file";
import {
  CHARACTER_CREATE_CHANNEL,
  CHARACTER_DELETE_CHANNEL,
  CHARACTER_LIST_CHANNEL,
  CHARACTER_UPDATE_CHANNEL,
} from "../shared/character";
import {
  SCENE_JOB_PROGRESS_CHANNEL,
  SCENE_JOB_RUN_CHANNEL,
  SCENE_JOB_CANCEL_CHANNEL,
  type SceneJobProgress,
} from "../shared/scene-job";
import {
  WORKER_STATUS_CHANNEL,
  WORKER_STATUS_GET_CHANNEL,
  type KCAutoToolBridge,
  type WorkerStatuses,
} from "../shared/worker-status";
import { MEDIA_GET_STREAM_URL_CHANNEL, MEDIA_READ_IMAGE_CHANNEL } from "../shared/media";
import {
  VISUAL_STYLE_DELETE_CHANNEL,
  VISUAL_STYLE_LIST_CHANNEL,
  VISUAL_STYLE_SAVE_CHANNEL,
} from "../shared/visual-style";
import {
  QUEUE_APPROVE_SCENE_CHANNEL,
  QUEUE_CLEAR_GENERATED_MEDIA_CHANNEL,
  QUEUE_CLEAR_SCENE_MEDIA_CHANNEL,
  QUEUE_CHANGED_CHANNEL,
  QUEUE_GENERATE_IMAGES_CHANNEL,
  QUEUE_GENERATE_VIDEOS_CHANNEL,
  QUEUE_PAUSE_CHANNEL,
  QUEUE_REGENERATE_SCENE_CHANNEL,
  QUEUE_REJECT_SCENE_CHANNEL,
  QUEUE_RESUME_CHANNEL,
  QUEUE_RESUME_FROM_CHANNEL,
  QUEUE_RETRY_FAILED_CHANNEL,
  QUEUE_SET_IMAGE_PROVIDER_CHANNEL,
  QUEUE_SET_VIDEO_PROVIDER_CHANNEL,
  QUEUE_SET_APPROVAL_POLICY_CHANNEL,
  QUEUE_SNAPSHOT_GET_CHANNEL,
  QUEUE_STOP_CHANNEL,
  type ProductionQueueSnapshot,
} from "../shared/production-queue";
import {
  VOICE_CANCEL_CHANNEL,
  VOICE_GENERATE_CHANNEL,
  VOICE_IMPORT_AUDIO_CHANNEL,
  VOICE_IMPORT_SUBTITLES_CHANNEL,
  VOICE_LIST_CHANNEL,
  VOICE_PREVIEW_CHANNEL,
  VOICE_PROGRESS_CHANNEL,
  type VoiceProgress,
} from "../shared/voice";
import {
  OUTPUT_EXPORT_SESSION_CHANNEL,
  OUTPUT_INSPECT_CHANNEL,
  OUTPUT_OPEN_CHANNEL,
  SYSTEM_OPEN_EXTENSION_FOLDER_CHANNEL,
  SYSTEM_OPEN_STORAGE_CHANNEL,
  SYSTEM_RESTART_CHANNEL,
  SYSTEM_SELECT_STORAGE_CHANNEL,
  SYSTEM_STATUS_CHANNEL,
} from "../shared/system";
import {
  CAPCUT_BUILD_TIMELINE_CHANNEL,
  CAPCUT_INSPECT_BUILD_CHANNEL,
} from "../shared/capcut";
import {
  EDIT_EXPORT_CHANNEL,
  EDIT_LOAD_CHANNEL,
  EDIT_PICK_VIDEO_CHANNEL,
  EDIT_SAVE_CHANNEL,
  EDIT_SYNC_CHANNEL,
} from "../shared/edit";
import {
  EDIT_ASSEMBLY_CANCEL_CHANNEL,
  EDIT_ASSEMBLY_PROGRESS_CHANNEL,
  EDIT_ASSEMBLY_START_CHANNEL,
  EDIT_ASSEMBLY_VALIDATE_CHANNEL,
  type AssemblyProgress,
} from "../shared/video-assembly";
import {
  PROVIDER_SETTINGS_GET_CHANNEL,
  PROVIDER_SETTINGS_SAVE_CHANNEL,
} from "../shared/provider";

const bridge: KCAutoToolBridge = {
  platform: process.platform,
  characters: {
    list: () => ipcRenderer.invoke(CHARACTER_LIST_CHANNEL),
    create: (input) => ipcRenderer.invoke(CHARACTER_CREATE_CHANNEL, input),
    update: (input) => ipcRenderer.invoke(CHARACTER_UPDATE_CHANNEL, input),
    remove: (token) => ipcRenderer.invoke(CHARACTER_DELETE_CHANNEL, token),
  },
  timeline: {
    generate: (input) => ipcRenderer.invoke(TIMELINE_GENERATE_CHANNEL, input),
    importPromptFile: (path) => ipcRenderer.invoke(PROMPT_FILE_IMPORT_CHANNEL, path),
    rewritePolicyPrompt: (input) => ipcRenderer.invoke(PROMPT_POLICY_REWRITE_CHANNEL, input),
    cancel: () => ipcRenderer.invoke(TIMELINE_CANCEL_CHANNEL),
    loadSession: () => ipcRenderer.invoke(TIMELINE_SESSION_LOAD_CHANNEL),
    saveSession: (input) => ipcRenderer.invoke(TIMELINE_SESSION_SAVE_CHANNEL, input),
    clearSession: () => ipcRenderer.invoke(TIMELINE_SESSION_CLEAR_CHANNEL),
    listSessions: () => ipcRenderer.invoke(TIMELINE_SESSION_LIST_CHANNEL),
    createSession: (name) => ipcRenderer.invoke(TIMELINE_SESSION_CREATE_CHANNEL, name),
    selectSession: (id) => ipcRenderer.invoke(TIMELINE_SESSION_SELECT_CHANNEL, id),
    renameSession: (id, name) => ipcRenderer.invoke(TIMELINE_SESSION_RENAME_CHANNEL, { id, name }),
    deleteSession: (id) => ipcRenderer.invoke(TIMELINE_SESSION_DELETE_CHANNEL, id),
    onProgress: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        value: TimelineProgress,
      ) => callback(value);
      ipcRenderer.on(TIMELINE_PROGRESS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(TIMELINE_PROGRESS_CHANNEL, listener);
    },
  },
  sceneJobs: {
    run: (input) => ipcRenderer.invoke(SCENE_JOB_RUN_CHANNEL, input),
    cancel: () => ipcRenderer.invoke(SCENE_JOB_CANCEL_CHANNEL),
    onProgress: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        value: SceneJobProgress,
      ) => callback(value);
      ipcRenderer.on(SCENE_JOB_PROGRESS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(SCENE_JOB_PROGRESS_CHANNEL, listener);
    },
  },
  media: {
    readImageDataUrl: (path) => ipcRenderer.invoke(MEDIA_READ_IMAGE_CHANNEL, path),
    getStreamUrl: (path) => ipcRenderer.invoke(MEDIA_GET_STREAM_URL_CHANNEL, path),
  },
  visualStyles: {
    list: () => ipcRenderer.invoke(VISUAL_STYLE_LIST_CHANNEL),
    save: (input) => ipcRenderer.invoke(VISUAL_STYLE_SAVE_CHANNEL, input),
    remove: (id) => ipcRenderer.invoke(VISUAL_STYLE_DELETE_CHANNEL, id),
  },
  productionQueue: {
    getSnapshot: (projectId) => ipcRenderer.invoke(QUEUE_SNAPSHOT_GET_CHANNEL, projectId),
    generateAllImages: (projectId, options) =>
      ipcRenderer.invoke(QUEUE_GENERATE_IMAGES_CHANNEL, { projectId, options }),
    generateAllVideos: (projectId, options) =>
      ipcRenderer.invoke(QUEUE_GENERATE_VIDEOS_CHANNEL, { projectId, options }),
    setImageProvider: (provider, projectId) =>
      ipcRenderer.invoke(QUEUE_SET_IMAGE_PROVIDER_CHANNEL, { provider, projectId }),
    setVideoProvider: (provider, projectId) =>
      ipcRenderer.invoke(QUEUE_SET_VIDEO_PROVIDER_CHANNEL, { provider, projectId }),
    pauseQueue: (projectId) => ipcRenderer.invoke(QUEUE_PAUSE_CHANNEL, { projectId }),
    resumeQueue: (projectId) => ipcRenderer.invoke(QUEUE_RESUME_CHANNEL, { projectId }),
    stopQueue: (projectId) => ipcRenderer.invoke(QUEUE_STOP_CHANNEL, { projectId }),
    clearGeneratedMedia: (projectId) =>
      ipcRenderer.invoke(QUEUE_CLEAR_GENERATED_MEDIA_CHANNEL, { projectId }),
    clearSceneMedia: (sceneId, projectId) =>
      ipcRenderer.invoke(QUEUE_CLEAR_SCENE_MEDIA_CHANNEL, { sceneId, projectId }),
    retryFailed: (sceneIds, projectId) =>
      ipcRenderer.invoke(QUEUE_RETRY_FAILED_CHANNEL, { sceneIds, projectId }),
    resumeFrom: (sceneId, mediaType, projectId) =>
      ipcRenderer.invoke(QUEUE_RESUME_FROM_CHANNEL, { sceneId, mediaType, projectId }),
    regenerateScene: (sceneId, mediaType, projectId) =>
      ipcRenderer.invoke(QUEUE_REGENERATE_SCENE_CHANNEL, { sceneId, mediaType, projectId }),
    approveScene: (sceneId, mediaType, projectId) =>
      ipcRenderer.invoke(QUEUE_APPROVE_SCENE_CHANNEL, { sceneId, mediaType, projectId }),
    rejectScene: (sceneId, mediaType, projectId) =>
      ipcRenderer.invoke(QUEUE_REJECT_SCENE_CHANNEL, { sceneId, mediaType, projectId }),
    setApprovalPolicy: (images, videos, projectId) =>
      ipcRenderer.invoke(QUEUE_SET_APPROVAL_POLICY_CHANNEL, { images, videos, projectId }),
    onChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        value: ProductionQueueSnapshot,
      ) => callback(value);
      ipcRenderer.on(QUEUE_CHANGED_CHANNEL, listener);
      return () => ipcRenderer.removeListener(QUEUE_CHANGED_CHANNEL, listener);
    },
  },
  voice: {
    list: (provider) => ipcRenderer.invoke(VOICE_LIST_CHANNEL, { provider }),
    preview: (voice, locale, provider) =>
      ipcRenderer.invoke(VOICE_PREVIEW_CHANNEL, { voice, locale, provider }),
    generate: (input) => ipcRenderer.invoke(VOICE_GENERATE_CHANNEL, input),
    importAudio: (projectId) => ipcRenderer.invoke(VOICE_IMPORT_AUDIO_CHANNEL, { projectId }),
    importSubtitles: (projectId, audioDurationSeconds) =>
      ipcRenderer.invoke(VOICE_IMPORT_SUBTITLES_CHANNEL, { projectId, audioDurationSeconds }),
    cancel: () => ipcRenderer.invoke(VOICE_CANCEL_CHANNEL),
    onProgress: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        value: VoiceProgress,
      ) => callback(value);
      ipcRenderer.on(VOICE_PROGRESS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(VOICE_PROGRESS_CHANNEL, listener);
    },
  },
  system: {
    getStatus: () => ipcRenderer.invoke(SYSTEM_STATUS_CHANNEL),
    openExtensionFolder: () => ipcRenderer.invoke(SYSTEM_OPEN_EXTENSION_FOLDER_CHANNEL),
    openStorage: (target) => ipcRenderer.invoke(SYSTEM_OPEN_STORAGE_CHANNEL, target),
    selectStorage: () => ipcRenderer.invoke(SYSTEM_SELECT_STORAGE_CHANNEL),
    restart: () => ipcRenderer.invoke(SYSTEM_RESTART_CHANNEL),
    inspectOutput: (projectId) => ipcRenderer.invoke(OUTPUT_INSPECT_CHANNEL, projectId),
    openOutput: (projectId, group) => ipcRenderer.invoke(OUTPUT_OPEN_CHANNEL, { projectId, group }),
    exportSession: (session) => ipcRenderer.invoke(OUTPUT_EXPORT_SESSION_CHANNEL, session),
  },
  capcut: {
    inspectBuild: (session, targetProjectPath, audioMode) => ipcRenderer.invoke(
      CAPCUT_INSPECT_BUILD_CHANNEL,
      { session, targetProjectPath, audioMode },
    ),
    buildTimeline: (session, options) => ipcRenderer.invoke(
      CAPCUT_BUILD_TIMELINE_CHANNEL,
      { session, options },
    ),
  },
  edit: {
    load: (session) => ipcRenderer.invoke(EDIT_LOAD_CHANNEL, session),
    sync: (session) => ipcRenderer.invoke(EDIT_SYNC_CHANNEL, session),
    save: (project) => ipcRenderer.invoke(EDIT_SAVE_CHANNEL, project),
    export: (project, options) => ipcRenderer.invoke(EDIT_EXPORT_CHANNEL, { project, options }),
    pickVideo: (sessionId: string) => ipcRenderer.invoke(EDIT_PICK_VIDEO_CHANNEL, sessionId),
    assembly: {
      validate: (project, settings) => ipcRenderer.invoke(EDIT_ASSEMBLY_VALIDATE_CHANNEL, { project, settings }),
      start: (project, settings) => ipcRenderer.invoke(EDIT_ASSEMBLY_START_CHANNEL, { project, settings }),
      cancel: (jobId: string) => ipcRenderer.invoke(EDIT_ASSEMBLY_CANCEL_CHANNEL, jobId),
      onProgress: (callback: (progress: AssemblyProgress) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, value: AssemblyProgress) => callback(value);
        ipcRenderer.on(EDIT_ASSEMBLY_PROGRESS_CHANNEL, listener);
        return () => ipcRenderer.removeListener(EDIT_ASSEMBLY_PROGRESS_CHANNEL, listener);
      },
    },
  },
  providerSettings: {
    get: () => ipcRenderer.invoke(PROVIDER_SETTINGS_GET_CHANNEL),
    save: (input) => ipcRenderer.invoke(PROVIDER_SETTINGS_SAVE_CHANNEL, input),
  },
  workers: {
    getStatuses: () => ipcRenderer.invoke(WORKER_STATUS_GET_CHANNEL),
    onStatusChange: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: WorkerStatuses) => {
        callback(value);
      };
      ipcRenderer.on(WORKER_STATUS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(WORKER_STATUS_CHANNEL, listener);
    },
  },
};

contextBridge.exposeInMainWorld("flowx", bridge);
