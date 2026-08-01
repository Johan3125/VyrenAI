import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Clock3,
  FileAudio,
  FileText,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_VISUAL_BIBLE,
  isImportedVoiceAudioSource,
  type TimelineSession,
  type TimelineWorkflowSource,
  type VoiceAudioSource,
} from "../shared/timeline";
import {
  DEFAULT_VOICE_PROVIDER,
  normalizeVoiceProvider,
  VOICE_PROVIDER_LABEL,
  type ImportedVoiceAudio,
  type ImportedVoiceSubtitles,
  type VoiceCatalogEntry,
  type VoicePauseLevel,
  type VoiceProvider,
} from "../shared/voice";
import type { HomeWorkflowMode, IntegratedWorkflowHandoff } from "./integrated-workflow";

const VOICE_PRESETS = [
  { key: "natural", label: "Tự nhiên", rate: 0, pitch: 0, volume: 0 },
  { key: "clear", label: "Chậm, rõ ràng", rate: -15, pitch: -5, volume: 0 },
  { key: "story", label: "Kể chuyện", rate: -5, pitch: -5, volume: 0 },
  { key: "fast", label: "Nhanh, năng động", rate: 15, pitch: 5, volume: 5 },
  { key: "news", label: "Tin tức", rate: 5, pitch: 0, volume: 5 },
] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanProjectName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 100);
}

function localeLabel(locale: string): string {
  try {
    const parsed = new Intl.Locale(locale);
    const languages = new Intl.DisplayNames(["vi"], { type: "language" });
    const regions = new Intl.DisplayNames(["vi"], { type: "region" });
    const language = languages.of(parsed.language) || parsed.language;
    const country = parsed.region ? regions.of(parsed.region) || parsed.region : "Không xác định";
    return `${country} · ${language}`;
  } catch {
    return locale;
  }
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(-2).map((part) => part[0]).join("").toUpperCase() || "VO";
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function estimatedDuration(words: number): string {
  if (!words) return "0:00";
  const seconds = Math.max(1, Math.round(words / 2.5));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainder = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Không rõ dung lượng";
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function restoredImportedAudio(session?: TimelineSession | null): ImportedVoiceAudio | null {
  const source = session?.workflowSource;
  if (!source || !isImportedVoiceAudioSource(source) || !source.audioPath) return null;
  return {
    audioPath: source.audioPath,
    audioFileName: source.audioFileName,
    sourceFileName: source.audioFileName,
    durationSeconds: source.audioDurationSeconds || 0,
    sizeBytes: source.audioSizeBytes || 0,
    codec: "mp3",
    bitRateKbps: 0,
    sampleRateHz: 0,
    channels: 0,
    warnings: [],
    subtitles: null,
  };
}

function restoredImportedSubtitles(
  session?: TimelineSession | null,
): ImportedVoiceSubtitles | null {
  const source = session?.workflowSource;
  if (!source || !isImportedVoiceAudioSource(source) || !source.srtText.trim()) return null;
  return {
    srtPath: source.srtPath,
    srtFileName: source.srtFileName,
    srtText: source.srtText,
    transcript: source.narrationText || source.scriptText,
    cueCount: (source.srtText.match(/-->/g) || []).length,
    durationSeconds: 0,
    warnings: [],
  };
}

function restoredGeneratedVoiceProvider(
  session?: TimelineSession | null,
): VoiceProvider {
  const provider = normalizeVoiceProvider(session?.workflowSource.voiceProvider);
  return provider === "imported" ? DEFAULT_VOICE_PROVIDER : provider;
}

export function VoiceWorkflow({
  mode,
  session,
  onBack,
  onComplete,
}: {
  mode: Exclude<HomeWorkflowMode, "script_to_media">;
  session?: TimelineSession | null;
  onBack: () => void;
  onComplete: (handoff: IntegratedWorkflowHandoff) => void;
}) {
  const [projectName, setProjectName] = useState(session?.name || "Video mới");
  const [sourceMode, setSourceMode] = useState<VoiceAudioSource>(
    session && isImportedVoiceAudioSource(session.workflowSource) ? "imported" : "generated",
  );
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>(
    restoredGeneratedVoiceProvider(session),
  );
  const [narrationFileName, setNarrationFileName] = useState(session?.workflowSource.narrationFileName || "");
  const [narrationText, setNarrationText] = useState(session?.workflowSource.narrationText || "");
  const [scriptFileName, setScriptFileName] = useState(session?.workflowSource.scriptFileName || "");
  const [scriptText, setScriptText] = useState(session?.workflowSource.scriptText || "");
  const [voices, setVoices] = useState<VoiceCatalogEntry[]>([]);
  const [voiceLoading, setVoiceLoading] = useState(true);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceLocale, setVoiceLocale] = useState("");
  const [voiceGender, setVoiceGender] = useState<"all" | "Female" | "Male">("all");
  const [selectedVoice, setSelectedVoice] = useState(session?.workflowSource.voiceName || "");
  const [rate, setRate] = useState(session?.workflowSource.voiceRate ?? 0);
  const [pitch, setPitch] = useState(session?.workflowSource.voicePitch ?? 0);
  const [volume, setVolume] = useState(session?.workflowSource.voiceVolume ?? 0);
  const [pauseLevel, setPauseLevel] = useState<VoicePauseLevel>(session?.workflowSource.voicePauseLevel || "medium");
  const [splitMode, setSplitMode] = useState<"paragraph" | "sentence">(session?.workflowSource.voiceSplitMode || "paragraph");
  const [maxCharsPerChunk, setMaxCharsPerChunk] = useState(session?.workflowSource.voiceMaxCharsPerChunk || 3000);
  const [exportWordSrt, setExportWordSrt] = useState(Boolean(session?.workflowSource.voiceExportWordSrt));
  const [scriptOpen, setScriptOpen] = useState(Boolean(session?.workflowSource.scriptText || session?.workflowSource.scriptFileName));
  const [longTextOpen, setLongTextOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<"quick" | "content">("quick");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewCurrent, setPreviewCurrent] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [importingAudio, setImportingAudio] = useState(false);
  const [importingSubtitles, setImportingSubtitles] = useState(false);
  const [importedAudio, setImportedAudio] = useState<ImportedVoiceAudio | null>(
    restoredImportedAudio(session),
  );
  const [importedSubtitles, setImportedSubtitles] = useState<ImportedVoiceSubtitles | null>(
    restoredImportedSubtitles(session),
  );
  const [importedAudioUrl, setImportedAudioUrl] = useState("");
  const [error, setError] = useState("");
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const projectSession = useRef<{ id: string; name: string } | null>(session ? { id: session.id, name: session.name } : null);

  useEffect(() => {
    if (!session) return;
    projectSession.current = { id: session.id, name: session.name };
    setProjectName(session.name);
    setSourceMode(isImportedVoiceAudioSource(session.workflowSource) ? "imported" : "generated");
    setVoiceProvider(restoredGeneratedVoiceProvider(session));
    setImportedAudio(restoredImportedAudio(session));
    setImportedSubtitles(restoredImportedSubtitles(session));
    setNarrationFileName(session.workflowSource.narrationFileName || "");
    setNarrationText(session.workflowSource.narrationText || "");
    setScriptFileName(session.workflowSource.scriptFileName || "");
    setScriptText(session.workflowSource.scriptText || "");
    setSelectedVoice(session.workflowSource.voiceName || "");
    setRate(session.workflowSource.voiceRate ?? 0);
    setPitch(session.workflowSource.voicePitch ?? 0);
    setVolume(session.workflowSource.voiceVolume ?? 0);
    setPauseLevel(session.workflowSource.voicePauseLevel || "medium");
    setSplitMode(session.workflowSource.voiceSplitMode || "paragraph");
    setMaxCharsPerChunk(session.workflowSource.voiceMaxCharsPerChunk || 3000);
    setExportWordSrt(Boolean(session.workflowSource.voiceExportWordSrt));
    setScriptOpen(Boolean(session.workflowSource.scriptText || session.workflowSource.scriptFileName));
    setError("");
  }, [session?.id]);

  useEffect(() => {
    if (session) return undefined;
    let active = true;
    void window.flowx?.providerSettings.get().then(
      (settings) => {
        if (!active || !settings) return;
        const configured = normalizeVoiceProvider(settings.voiceProvider);
        if (configured === "imported") {
          setSourceMode("imported");
        } else {
          setVoiceProvider(configured);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [session?.id]);

  useEffect(() => {
    let active = true;
    const bridge = window.flowx;
    if (!bridge) return undefined;
    if (sourceMode === "imported") {
      setVoiceLoading(false);
      setVoices([]);
      previewAudio.current?.pause();
      return undefined;
    }
    setVoiceLoading(true);
    void bridge.voice.list(voiceProvider).then(
      (catalog) => {
        if (!active) return;
        const sorted = [...catalog].sort((left, right) => {
          const leftRank = left.locale.startsWith("vi-") ? 0 : 1;
          const rightRank = right.locale.startsWith("vi-") ? 0 : 1;
          return leftRank - rightRank || left.locale.localeCompare(right.locale) || left.friendlyName.localeCompare(right.friendlyName);
        });
        setVoices(sorted);
        const restored = session?.workflowSource.voiceName;
        const preferred = sorted.find((voice) => voice.shortName === restored)
          || sorted.find((voice) => voice.shortName === "vi-VN-HoaiMyNeural")
          || sorted[0];
        setSelectedVoice((current) =>
          current && sorted.some((voice) => voice.shortName === current)
            ? current
            : preferred?.shortName || "",
        );
        setVoiceLoading(false);
      },
      (caught) => {
        if (!active) return;
        setVoiceLoading(false);
        setError(message(caught));
      },
    );
    return () => {
      active = false;
      previewAudio.current?.pause();
    };
  }, [session?.id, sourceMode, voiceProvider]);

  useEffect(() => {
    previewAudio.current?.pause();
    setPreviewPlaying(false);
    setPreviewCurrent(0);
    setPreviewDuration(0);
    setVoiceSearch("");
    setVoiceLocale("");
    setVoiceGender("all");
    if (voiceProvider !== "edge") setExportWordSrt(false);
  }, [voiceProvider]);

  useEffect(() => {
    let active = true;
    setImportedAudioUrl("");
    if (sourceMode !== "imported" || !importedAudio?.audioPath) return undefined;
    void window.flowx?.media.getStreamUrl(importedAudio.audioPath).then(
      (url) => {
        if (active) setImportedAudioUrl(url);
      },
      () => {
        if (active) setImportedAudioUrl("");
      },
    );
    return () => {
      active = false;
    };
  }, [importedAudio?.audioPath, sourceMode]);

  const filteredVoices = useMemo(() => {
    const query = voiceSearch.trim().toLocaleLowerCase();
    return voices.filter((voice) => {
      if (voiceLocale && voice.locale !== voiceLocale) return false;
      if (voiceGender !== "all" && voice.gender !== voiceGender) return false;
      if (!query) return true;
      return `${voice.friendlyName} ${voice.shortName} ${voice.locale}`.toLocaleLowerCase().includes(query);
    });
  }, [voiceGender, voiceLocale, voiceSearch, voices]);
  const voiceLocales = useMemo(() => [...new Set(voices.map((voice) => voice.locale))].sort((left, right) => localeLabel(left).localeCompare(localeLabel(right), "vi")), [voices]);

  useEffect(() => {
    if (!filteredVoices.length || filteredVoices.some((voice) => voice.shortName === selectedVoice)) return;
    setSelectedVoice(filteredVoices[0].shortName);
  }, [filteredVoices, selectedVoice]);

  const selected = voices.find((voice) => voice.shortName === selectedVoice) || null;
  const previewSupported = voiceProvider === "edge";
  const voiceProsodySupported = voiceProvider === "edge";
  const words = wordCount(narrationText);
  const importedSourceReady = Boolean(
    importedAudio?.audioPath &&
    importedSubtitles?.srtText.trim() &&
    (narrationText.trim() || scriptText.trim()),
  );
  const canContinue = Boolean(
    !saving &&
    (sourceMode === "imported"
      ? importedSourceReady
      : narrationText.trim() && selectedVoice),
  );
  const contentPreview = narrationText.trim().slice(0, 180) || "Chưa có nội dung để preview.";
  const previewPercent = previewDuration ? Math.min(100, (previewCurrent / previewDuration) * 100) : 0;

  const chooseTextFile = async (file: File | undefined, kind: "narration" | "script") => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("File văn bản vượt quá giới hạn 2 MB.");
      return;
    }
    const text = await file.text();
    if (kind === "narration") {
      setNarrationFileName(file.name);
      setNarrationText(text);
      if (projectName === "Video mới") setProjectName(cleanProjectName(file.name) || "Video mới");
    } else {
      setScriptFileName(file.name);
      setScriptText(text);
      setScriptOpen(true);
    }
    setError("");
  };

  const preview = async (voiceOverride?: VoiceCatalogEntry) => {
    const voice = voiceOverride || selected;
    if (!voice || !window.flowx) return;
    if (!previewSupported) {
      setError("Preview in app is available for Microsoft Edge TTS only. Use the provider website for CapCut Voice Web preview.");
      return;
    }
    setError("");
    setPreviewLoading(true);
    try {
      previewAudio.current?.pause();
      const dataUrl = await window.flowx.voice.preview(voice.shortName, voice.locale, voiceProvider);
      const audio = new Audio(dataUrl);
      previewAudio.current = audio;
      audio.addEventListener("loadedmetadata", () => setPreviewDuration(audio.duration || 0));
      audio.addEventListener("timeupdate", () => setPreviewCurrent(audio.currentTime));
      audio.addEventListener("play", () => setPreviewPlaying(true));
      audio.addEventListener("pause", () => setPreviewPlaying(false));
      audio.addEventListener("ended", () => { setPreviewPlaying(false); setPreviewCurrent(0); });
      await audio.play();
    } catch (caught) {
      setError(`Không nghe thử được giọng: ${message(caught)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const togglePreview = () => {
    const audio = previewAudio.current;
    if (!audio) {
      void preview();
      return;
    }
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const pasteFromClipboard = async () => {
    try {
      setNarrationText(await navigator.clipboard.readText());
      setNarrationFileName("");
      setError("");
    } catch (caught) {
      setError(`Không thể dán clipboard: ${message(caught)}`);
    }
  };

  const ensureWorkspaceSession = async () => {
    const bridge = window.flowx;
    if (!bridge) throw new Error("Desktop bridge chưa sẵn sàng.");
    const workspaceSession = projectSession.current ||
      await bridge.timeline.createSession(projectName.trim() || "Video mới");
    projectSession.current = { id: workspaceSession.id, name: workspaceSession.name };
    const nextName = projectName.trim() || workspaceSession.name;
    if (nextName !== workspaceSession.name) {
      await bridge.timeline.renameSession(workspaceSession.id, nextName);
      projectSession.current = { id: workspaceSession.id, name: nextName };
    }
    return { ...workspaceSession, name: nextName };
  };

  const chooseImportedAudio = async () => {
    const bridge = window.flowx;
    if (!bridge) return;
    setImportingAudio(true);
    setError("");
    try {
      const workspaceSession = await ensureWorkspaceSession();
      const imported = await bridge.voice.importAudio(workspaceSession.id);
      if (!imported) return;
      setSourceMode("imported");
      setImportedAudio(imported);
      setImportedSubtitles(imported.subtitles);
      if (imported.subtitles?.transcript) {
        setNarrationText(imported.subtitles.transcript);
        setNarrationFileName(imported.subtitles.srtFileName);
      } else {
        setNarrationText("");
        setNarrationFileName("");
      }
      if (projectName === "Video mới") {
        setProjectName(cleanProjectName(imported.sourceFileName) || "Video mới");
      }
    } catch (caught) {
      setError(`Không thể nhập MP3: ${message(caught)}`);
    } finally {
      setImportingAudio(false);
    }
  };

  const chooseImportedSubtitles = async () => {
    const bridge = window.flowx;
    if (!bridge || !importedAudio) return;
    setImportingSubtitles(true);
    setError("");
    try {
      const workspaceSession = await ensureWorkspaceSession();
      const imported = await bridge.voice.importSubtitles(
        workspaceSession.id,
        importedAudio.durationSeconds,
      );
      if (!imported) return;
      setImportedSubtitles(imported);
      setNarrationText(imported.transcript);
      setNarrationFileName(imported.srtFileName);
    } catch (caught) {
      setError(`Không thể nhập SRT: ${message(caught)}`);
    } finally {
      setImportingSubtitles(false);
    }
  };

  const clearImportedAudio = () => {
    setImportedAudio(null);
    setImportedSubtitles(null);
    setImportedAudioUrl("");
    setNarrationText("");
    setNarrationFileName("");
  };

  const continueSetup = async (advance = true) => {
    const bridge = window.flowx;
    if (!bridge || (advance && !canContinue)) return;
    setSaving(true);
    setError("");
    try {
      const workspaceSession = await ensureWorkspaceSession();
      const imported = sourceMode === "imported";
      const source: TimelineWorkflowSource = {
        narrationText,
        narrationFileName: narrationFileName || (imported ? importedSubtitles?.srtFileName || "" : "loi-thoai.txt"),
        narrationPath: "",
        srtText: imported ? importedSubtitles?.srtText || "" : "",
        scriptText: scriptText.trim() || narrationText.trim(),
        srtFileName: imported ? importedSubtitles?.srtFileName || "" : "",
        scriptFileName: scriptFileName || narrationFileName || "loi-thoai.txt",
        srtPath: imported ? importedSubtitles?.srtPath || "" : "",
        scriptPath: "",
        audioPath: imported ? importedAudio?.audioPath || "" : "",
        audioFileName: imported ? importedAudio?.audioFileName || "" : "",
        audioSource: sourceMode,
        audioDurationSeconds: imported ? importedAudio?.durationSeconds || 0 : 0,
        audioSizeBytes: imported ? importedAudio?.sizeBytes || 0 : 0,
        voiceProvider: imported ? "imported" : voiceProvider,
        voiceName: imported ? "" : selectedVoice,
        voiceRate: rate,
        voicePitch: pitch,
        voiceVolume: volume,
        voicePauseLevel: pauseLevel,
        voiceSplitMode: splitMode,
        voiceMaxCharsPerChunk: maxCharsPerChunk,
        voiceExportWordSrt: exportWordSrt,
      };
      const workflowMode = mode === "full_auto" ? "automatic" : "two_step";
      await bridge.timeline.saveSession({
        scenes: session?.scenes || [],
        visualBible: session?.visualBible || DEFAULT_VISUAL_BIBLE,
        styleReference: session?.styleReference || null,
        workflowMode,
        workflowSource: source,
      });
      if (advance) {
        onComplete({
          id: `${workspaceSession.id}:${Date.now()}`,
          sessionId: workspaceSession.id,
          workflowMode,
          workflowSource: source,
          visualBible: session?.visualBible || DEFAULT_VISUAL_BIBLE,
          styleReference: session?.styleReference || null,
          autoGenerateTimeline: false,
        });
      }
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="kc-voice-studio">
      <header className="kc-voice-page-header">
        <div>
          <div className="kc-voice-breadcrumb"><span>VOICE STUDIO</span><i>•</i><b>{projectName || "Video mới"}</b></div>
          <h1>Voice Studio</h1>
          <p>Tạo giọng bằng AI hoặc dùng voice audio MP3 có sẵn.</p>
        </div>
        <div className="kc-voice-header-meta">
          <span className="kc-voice-session-pill"><i />{mode === "full_auto" ? "Tự động toàn bộ" : "Tạo từng bước"}</span>
          <span className="kc-voice-saved"><Check size={13} /> {saving ? "Đang lưu…" : "Lưu theo thao tác"}</span>
          <button className="kc-voice-outline-button" type="button" disabled={saving} onClick={() => void continueSetup(false)}>Lưu bản nháp</button>
        </div>
      </header>

      <div className="kc-voice-stepper" aria-label="Tiến trình thiết lập">
        {[
          ["01", "Voice audio & nội dung", "Đang thực hiện", "active"],
          ["02", "Nhân vật", "Tiếp theo", "locked"],
          ["03", "Visual Bible", "Tiếp theo", "locked"],
          ["04", "Bắt đầu workflow", "Sau khi hoàn tất", "locked"],
        ].map(([number, title, detail, state], index) => (
          <div className={`kc-voice-step ${state}`} key={number}>
            <span className="kc-voice-step-index">{state === "locked" ? "🔒" : number}</span>
            <div><strong>{title}</strong><small>{detail}</small></div>
            {index < 3 && <span className="kc-voice-step-line" />}
          </div>
        ))}
      </div>

      <div className="kc-voice-layout">
        <div className="kc-voice-left-column">
          <article className="kc-voice-card kc-voice-script-card">
            <div className="kc-voice-card-header"><div className="kc-voice-card-title"><span className="kc-voice-card-number">01</span><div><h2>{sourceMode === "imported" ? "Voice audio có sẵn" : "Nội dung thoại"} <em>*</em></h2><p>{sourceMode === "imported" ? "MP3 được dùng trực tiếp; app không chọn hoặc tạo lại giọng đọc." : "Nội dung bắt buộc để tạo Voice và SRT ở bước cuối."}</p></div></div><span className="kc-voice-required">BẮT BUỘC</span></div>
            <div className="kc-voice-source-mode" role="group" aria-label="Nguồn voice audio">
              <button type="button" className={sourceMode === "generated" ? "is-selected" : ""} onClick={() => setSourceMode("generated")}><Volume2 size={14} /><span><b>Tạo voice bằng AI</b><small>Nhập nội dung và chọn giọng đọc</small></span></button>
              <button type="button" className={sourceMode === "imported" ? "is-selected" : ""} onClick={() => setSourceMode("imported")}><FileAudio size={14} /><span><b>Dùng MP3 có sẵn</b><small>Bỏ qua chọn voice và TTS</small></span></button>
            </div>
            {sourceMode === "generated" ? <>
              <div className="kc-voice-toolbar">
                <button type="button" onClick={() => void pasteFromClipboard()}><Clipboard size={14} /> Dán clipboard</button>
                <label><Upload size={14} /> Nhập .txt<input className="visually-hidden-file" type="file" accept=".txt,text/plain" onChange={(event) => void chooseTextFile(event.target.files?.[0], "narration")} /></label>
                <label><Upload size={14} /> Nhập .md<input className="visually-hidden-file" type="file" accept=".md,text/markdown" onChange={(event) => void chooseTextFile(event.target.files?.[0], "narration")} /></label>
                <button type="button" disabled={!narrationText} onClick={() => { setNarrationText(""); setNarrationFileName(""); }}><Trash2 size={14} /> Xóa</button>
                {narrationFileName && <span className="kc-voice-file-chip"><FileText size={12} /> {narrationFileName}</span>}
              </div>
              <textarea className="kc-voice-main-textarea" value={narrationText} placeholder="Nhập hoặc dán toàn bộ nội dung cần đọc…" onChange={(event) => setNarrationText(event.target.value)} />
              <div className="kc-voice-textarea-footer"><span>{narrationText.length.toLocaleString("vi-VN")} ký tự</span><span>{words.toLocaleString("vi-VN")} từ</span><span><Clock3 size={13} /> Ước tính {estimatedDuration(words)}</span><label>Tên phiên <input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label></div>
              {narrationText.length > 120_000 && <div className="kc-voice-inline-warning"><AlertTriangle size={14} /> Nội dung dài; app sẽ tự chia đoạn để xử lý ổn định.</div>}
              {voiceProvider === "capcut-web" && <div className="kc-voice-inline-warning"><AlertTriangle size={14} /> CapCut Voice Web is experimental in this build. If extension voice automation is not available yet, generate/download audio on CapCut and import the MP3/SRT.</div>}
              {!narrationText.trim() && <div className="kc-voice-inline-hint">Bắt đầu bằng cách dán nội dung thoại hoặc nhập file văn bản.</div>}
            </> : <>
              <div className="kc-imported-audio-actions">
                <button type="button" disabled={importingAudio || saving} onClick={() => void chooseImportedAudio()}><FolderOpen size={14} /> {importingAudio ? "Đang kiểm tra MP3…" : importedAudio ? "Đổi file .mp3" : "Chọn file .mp3"}</button>
                <button type="button" disabled={!importedAudio || importingSubtitles || saving} onClick={() => void chooseImportedSubtitles()}><FileText size={14} /> {importingSubtitles ? "Đang kiểm tra SRT…" : importedSubtitles ? "Đổi file .srt" : "Chọn file .srt"}</button>
                <button type="button" disabled={!importedAudio || saving} onClick={clearImportedAudio}><Trash2 size={14} /> Bỏ file</button>
              </div>
              {importedAudio ? <div className="kc-imported-audio-file">
                <div className="kc-imported-audio-head"><span><FileAudio size={18} /></span><div><strong>{importedAudio.sourceFileName || importedAudio.audioFileName}</strong><small>Đã sao chép an toàn vào thư mục output của phiên</small></div><b>MP3</b></div>
                <div className="kc-imported-audio-metrics"><span><b>{durationLabel(importedAudio.durationSeconds)}</b> thời lượng</span><span><b>{fileSizeLabel(importedAudio.sizeBytes)}</b> dung lượng</span><span><b>{importedAudio.bitRateKbps ? `${importedAudio.bitRateKbps} kbps` : "MP3"}</b> bitrate</span><span><b>{importedAudio.sampleRateHz ? `${(importedAudio.sampleRateHz / 1_000).toFixed(1)} kHz` : "Đã xác minh"}</b> sample rate</span></div>
                {importedAudioUrl && <audio className="kc-imported-audio-player" controls preload="metadata" src={importedAudioUrl} />}
                {[...importedAudio.warnings, ...(importedSubtitles?.warnings || [])].map((warning) => <p className="kc-imported-audio-warning" key={warning}><AlertTriangle size={13} /> {warning}</p>)}
              </div> : <div className="kc-imported-audio-empty"><FileAudio size={24} /><strong>Chưa chọn voice audio</strong><p>App chấp nhận MP3 tối đa 500 MB, kiểm tra bằng FFprobe và không chỉnh sửa file gốc.</p></div>}
              <div className={`kc-imported-srt-status ${importedSubtitles ? "is-ready" : ""}`}><span>{importedSubtitles ? <Check size={14} /> : <Clock3 size={14} />}</span><div><strong>{importedSubtitles ? importedSubtitles.srtFileName : "Cần SRT đồng bộ"}</strong><small>{importedSubtitles ? `${importedSubtitles.cueCount} cue · kết thúc ${durationLabel(importedSubtitles.durationSeconds)}` : "Nếu cạnh MP3 có file .srt cùng tên, app sẽ tự nhập; nếu không hãy chọn thủ công."}</small></div></div>
              <label className="kc-imported-transcript"><span>Transcript dùng phân tích hình ảnh</span><textarea value={narrationText} placeholder="Transcript sẽ tự điền từ SRT. Có thể chỉnh lại nội dung mô tả nhưng timestamp vẫn lấy từ SRT." onChange={(event) => setNarrationText(event.target.value)} /></label>
              <div className="kc-voice-textarea-footer"><span>{narrationText.length.toLocaleString("vi-VN")} ký tự transcript</span><span>{words.toLocaleString("vi-VN")} từ</span><span><Clock3 size={13} /> Audio {durationLabel(importedAudio?.durationSeconds || 0)}</span><label>Tên phiên <input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label></div>
            </>}
          </article>

          <article className={`kc-voice-card kc-voice-script-optional ${scriptOpen ? "is-open" : ""}`}>
            <button className="kc-voice-collapsible-header" type="button" onClick={() => setScriptOpen((value) => !value)}><span><FileText size={16} /><b>Kịch bản hình ảnh tùy chọn</b><small>{scriptText.trim() ? "Đã có kịch bản riêng" : "Bỏ trống để dùng nội dung thoại"}</small></span><ChevronDown size={17} /></button>
            {scriptOpen && <div className="kc-voice-collapsible-body"><div className="kc-voice-toolbar"><label><Upload size={14} /> Nhập .txt/.md<input className="visually-hidden-file" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void chooseTextFile(event.target.files?.[0], "script")} /></label>{scriptFileName && <span className="kc-voice-file-chip"><FileText size={12} /> {scriptFileName}</span>}<button type="button" disabled={!scriptText} onClick={() => { setScriptText(""); setScriptFileName(""); }}><Trash2 size={14} /> Xóa</button></div><textarea className="kc-voice-script-textarea" value={scriptText} placeholder="Nhập mô tả hình ảnh riêng nếu không muốn dùng nguyên văn nội dung thoại…" onChange={(event) => setScriptText(event.target.value)} /><p className="kc-voice-muted-note">Nếu bỏ trống, nội dung thoại sẽ được sử dụng làm nguồn phân tích hình ảnh.</p></div>}
          </article>

          {sourceMode === "generated" && <><article className="kc-voice-card">
            <div className="kc-voice-card-header"><div className="kc-voice-card-title"><span className="kc-voice-card-number">02</span><div><h2>Điều chỉnh giọng đọc</h2><p>Thiết lập sẽ được lưu và áp dụng khi tạo Voice cuối.</p></div></div></div>
            <div className="kc-voice-preset-row">{VOICE_PRESETS.map((preset) => <button key={preset.key} disabled={!voiceProsodySupported} className={rate === preset.rate && pitch === preset.pitch && volume === preset.volume ? "is-selected" : ""} type="button" onClick={() => { setRate(preset.rate); setPitch(preset.pitch); setVolume(preset.volume); }}>{preset.label}</button>)}</div>
            <div className="kc-voice-slider-grid">
              <label><span>Tốc độ <b>{rate >= 0 ? "+" : ""}{rate}%</b></span><input type="range" min="-50" max="50" step="5" value={rate} disabled={!voiceProsodySupported} onChange={(event) => setRate(Number(event.target.value))} /></label>
              <label><span>Cao độ <b>{pitch >= 0 ? "+" : ""}{pitch}Hz</b></span><input type="range" min="-50" max="50" step="5" value={pitch} disabled={!voiceProsodySupported} onChange={(event) => setPitch(Number(event.target.value))} /></label>
              <label><span>Âm lượng <b>{volume >= 0 ? "+" : ""}{volume}%</b></span><input type="range" min="-50" max="50" step="5" value={volume} disabled={!voiceProsodySupported} onChange={(event) => setVolume(Number(event.target.value))} /></label>
            </div>
            <div className="kc-voice-control-grid"><label><span>Khoảng nghỉ giữa đoạn</span><select value={pauseLevel} disabled={!voiceProsodySupported} onChange={(event) => setPauseLevel(event.target.value as VoicePauseLevel)}><option value="off">Tắt</option><option value="medium">Vừa</option><option value="strong">Mạnh</option><option value="dramatic">Kịch tính</option></select></label><label className="kc-voice-disabled-control" title="Engine hiện tại chưa hỗ trợ tùy chọn này."><span>Cảm xúc / phong cách đọc</span><select disabled><option>Đang phát triển</option></select></label></div>
            <div className="kc-voice-card-actions"><button type="button" disabled={!voiceProsodySupported} onClick={() => { setRate(0); setPitch(0); setVolume(0); setPauseLevel("medium"); }}><RotateCcw size={14} /> Đặt lại mặc định</button><button type="button" disabled={!selected || previewLoading || !previewSupported} onClick={() => void preview()}><Volume2 size={14} /> Nghe thử cấu hình</button></div>
          </article>

          <article className={`kc-voice-card kc-voice-long-processing ${longTextOpen ? "is-open" : ""}`}>
            <button className="kc-voice-collapsible-header" type="button" onClick={() => setLongTextOpen((value) => !value)}><span><span className="kc-voice-card-number">03</span><b>Xử lý nội dung dài</b><small>Cấu hình cách chia đoạn trước khi bắt đầu workflow</small></span><ChevronDown size={17} /></button>
            {longTextOpen && <div className="kc-voice-collapsible-body"><div className="kc-voice-process-track">{["Kịch bản gốc", "Tách đoạn", "Tạo voice", "Gộp audio", "Cân timing", "Xuất SRT"].map((label, index) => <div key={label}><i>{index + 1}</i><span>{label}</span>{index < 5 && <b>→</b>}</div>)}</div><div className="kc-voice-control-grid"><label><span>Cách tách đoạn</span><select value={splitMode} onChange={(event) => setSplitMode(event.target.value as "paragraph" | "sentence")}><option value="paragraph">Ưu tiên theo đoạn văn</option><option value="sentence">Ưu tiên theo câu</option></select></label><label><span>Số ký tự tối đa mỗi đoạn</span><select value={maxCharsPerChunk} onChange={(event) => setMaxCharsPerChunk(Number(event.target.value))}><option value={1000}>1.000 ký tự</option><option value={2000}>2.000 ký tự</option><option value={3000}>3.000 ký tự</option></select></label></div><label className="kc-voice-checkbox"><input type="checkbox" checked={exportWordSrt} disabled={saving || voiceProvider !== "edge"} onChange={(event) => setExportWordSrt(event.target.checked)} /> Xuất thêm SRT theo từng từ</label></div>}
          </article></>}
        </div>

        <aside className="kc-voice-right-column">
          {sourceMode === "generated" ? <><article className="kc-voice-card kc-voice-filter-card">
            <div className="kc-voice-card-header"><div className="kc-voice-card-title"><span className="kc-voice-card-number">A</span><div><h2>Tìm giọng đọc</h2><p>Lọc theo quốc gia, ngôn ngữ hoặc tên người đọc.</p></div></div></div>
            <div className="kc-voice-filter-stack">
              <label>
                <span>TTS engine</span>
                <select value={voiceProvider} onChange={(event) => setVoiceProvider(event.target.value as VoiceProvider)}>
                  <option value="edge">{VOICE_PROVIDER_LABEL.edge}</option>
                  <option value="capcut-web">{VOICE_PROVIDER_LABEL["capcut-web"]} (Experimental)</option>
                </select>
              </label>
              <label><span>Quốc gia / ngôn ngữ</span><select value={voiceLocale} onChange={(event) => setVoiceLocale(event.target.value)}><option value="">Tất cả quốc gia</option>{voiceLocales.map((locale) => <option key={locale} value={locale}>{localeLabel(locale)}</option>)}</select></label>
              <label className="kc-voice-search-field"><span>Tìm theo tên hoặc mã voice</span><Search size={14} /><input value={voiceSearch} placeholder="Ví dụ: Hoài My, Jenny…" onChange={(event) => setVoiceSearch(event.target.value)} /></label>
              <div className="kc-voice-gender-filter">{[["all", "Tất cả"], ["Female", "Nữ"], ["Male", "Nam"]].map(([key, label]) => <button key={key} type="button" className={voiceGender === key ? "is-selected" : ""} onClick={() => setVoiceGender(key as "all" | "Female" | "Male")}>{label}</button>)}</div>
            </div>
          </article>

          <article className="kc-voice-card kc-voice-catalog-card"><div className="kc-voice-list-header"><div><h2>Danh sách giọng</h2><p>{voiceLoading ? "Đang tải catalog…" : `${filteredVoices.length} giọng phù hợp`}</p></div><FileAudio size={17} /></div><div className="kc-voice-catalog-list">{voiceLoading ? <div className="kc-voice-empty-state"><span className="kc-voice-spinner" /> Đang tải danh sách voice…</div> : !filteredVoices.length ? <div className="kc-voice-empty-state"><Search size={18} /> Không tìm thấy giọng phù hợp.</div> : filteredVoices.map((voice) => <div role="button" tabIndex={0} key={voice.shortName} className={`kc-voice-catalog-item ${voice.shortName === selectedVoice ? "is-selected" : ""}`} onClick={() => setSelectedVoice(voice.shortName)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedVoice(voice.shortName); }}><span className="kc-voice-avatar">{initials(voice.friendlyName)}</span><span className="kc-voice-catalog-copy"><strong>{voice.friendlyName}</strong><small>{localeLabel(voice.locale)} · {voice.gender === "Female" ? "Nữ" : voice.gender === "Male" ? "Nam" : voice.gender}</small><code>{voice.shortName}</code></span><span className="kc-voice-catalog-action">{voice.shortName === selectedVoice ? <span className="kc-voice-selected-badge"><Check size={12} /> Đang chọn</span> : <button type="button" disabled={!previewSupported} aria-label={`Nghe thử ${voice.friendlyName}`} onClick={(event) => { event.stopPropagation(); setSelectedVoice(voice.shortName); void preview(voice); }}><Play size={13} /></button>}</span></div>)}</div></article>

          <article className="kc-voice-card kc-voice-selected-card"><div className="kc-voice-selected-head"><span className="kc-voice-avatar large">{selected ? initials(selected.friendlyName) : "—"}</span><div><span className="kc-voice-overline">GIỌNG ĐÃ CHỌN</span><h2>{selected?.friendlyName || "Chưa chọn giọng"}</h2><p>{selected ? `${localeLabel(selected.locale)} · ${selected.gender === "Female" ? "Nữ" : selected.gender === "Male" ? "Nam" : selected.gender}` : "Chọn một voice trong danh sách"}</p></div><span className="kc-voice-status-badge">{selected ? <><Check size={12} /> Đã chọn</> : "Thiếu"}</span></div>{selected && <div className="kc-voice-selected-meta"><code>{selected.shortName}</code><button type="button" disabled={previewLoading || !previewSupported} onClick={() => void preview()}><Play size={13} /> Nghe thử</button><button type="button" onClick={() => document.querySelector<HTMLElement>(".kc-voice-catalog-card")?.scrollIntoView({ behavior: "smooth", block: "center" })}>Đổi giọng</button></div>}</article>

          <article className="kc-voice-card kc-voice-preview-card"><div className="kc-voice-preview-tabs"><button type="button" className={previewTab === "quick" ? "is-active" : ""} onClick={() => setPreviewTab("quick")}>Preview nhanh</button><button type="button" className={previewTab === "content" ? "is-active" : ""} onClick={() => setPreviewTab("content")}>Dùng đoạn trong nội dung</button></div><div className="kc-voice-preview-copy"><span>{previewSupported ? previewTab === "content" ? contentPreview : "Nghe thử giọng mẫu trước khi lưu cấu hình." : "Provider này preview trên website gốc."}</span></div><div className="kc-voice-player"><button type="button" className="kc-voice-play-button" disabled={!selected || previewLoading || !previewSupported} onClick={togglePreview}>{previewLoading ? <span className="kc-voice-spinner" /> : previewPlaying ? <Pause size={17} /> : <Play size={17} />}</button><div className="kc-voice-progress"><span style={{ width: `${previewPercent}%` }} /><input aria-label="Tiến trình preview" type="range" min="0" max={previewDuration || 1} step="0.01" value={previewCurrent} disabled={!previewSupported} onChange={(event) => { if (previewAudio.current) previewAudio.current.currentTime = Number(event.target.value); }} /></div><small>{Math.floor(previewCurrent)}:{String(Math.floor(previewDuration) % 60).padStart(2, "0")}</small></div><p className="kc-voice-preview-note">{previewSupported ? "Preview hiện dùng endpoint giọng mẫu; tốc độ/pitch sẽ được áp dụng khi tạo Voice cuối." : "CapCut Voice Web sẽ cần automation extension riêng hoặc import MP3/SRT sau khi tải audio từ CapCut."}</p></article></> : <>
            <article className="kc-voice-card kc-imported-summary-card"><div className="kc-voice-list-header"><div><h2>Chế độ dùng audio có sẵn</h2><p>Không gọi Edge TTS và không áp dụng preset giọng.</p></div><FileAudio size={17} /></div><div className="kc-voice-bypass-banner"><Check size={16} /><div><strong>Đã bỏ qua chọn giọng đọc</strong><p>MP3 được giữ nguyên làm voice chính khi dựng video. Timeline chỉ dùng SRT để lấy timestamp và transcript để phân tích nội dung.</p></div></div><dl><div><dt>Audio</dt><dd>{importedAudio ? "Đã xác minh" : "Còn thiếu"}</dd></div><div><dt>Subtitle</dt><dd>{importedSubtitles ? `${importedSubtitles.cueCount} cue` : "Còn thiếu SRT"}</dd></div><div><dt>TTS</dt><dd>Không sử dụng</dd></div><div><dt>Đồng bộ</dt><dd>{importedSubtitles ? "Đã kiểm tra" : "Chưa kiểm tra"}</dd></div></dl></article>
            <article className="kc-voice-card kc-imported-guidance"><div className="kc-voice-list-header"><div><h2>Tiêu chuẩn đầu vào</h2><p>Thiết lập thực tế cho sản xuất video.</p></div><Check size={17} /></div><ul><li>MP3 có audio stream hợp lệ, tối đa 500 MB và 6 giờ.</li><li>SRT phải có timestamp tăng dần và không dài hơn audio quá 2 giây.</li><li>Transcript được tách từ SRT; kịch bản hình ảnh riêng vẫn là tùy chọn.</li><li>File gốc không bị sửa; app dùng bản sao trong output của phiên.</li></ul></article>
          </>}

          <article className="kc-voice-card kc-voice-readiness-card"><div className="kc-voice-list-header"><div><h2>Kiểm tra dữ liệu</h2><p>Điều kiện trước khi tiếp tục sang Nhân vật.</p></div><Check size={17} /></div>{sourceMode === "generated" ? <ul><li className={narrationText.trim() ? "is-valid" : "is-missing"}><span>{narrationText.trim() ? <Check size={13} /> : <AlertTriangle size={13} />}</span><b>Nội dung thoại</b><small>{narrationText.trim() ? "Đã có" : "Còn thiếu"}</small></li><li className={selected ? "is-valid" : "is-missing"}><span>{selected ? <Check size={13} /> : <AlertTriangle size={13} />}</span><b>Giọng đọc</b><small>{selected ? "Đã chọn" : "Còn thiếu"}</small></li><li className="is-valid"><span><Check size={13} /></span><b>Cấu hình giọng</b><small>Đã lưu</small></li><li className={scriptText.trim() ? "is-valid" : "is-neutral"}><span>{scriptText.trim() ? <Check size={13} /> : <FileText size={13} />}</span><b>Kịch bản hình ảnh</b><small>{scriptText.trim() ? "Có" : "Không sử dụng"}</small></li><li className="is-deferred"><span><Clock3 size={13} /></span><b>Audio + SRT</b><small>Sẽ tạo khi bắt đầu workflow</small></li></ul> : <ul><li className={importedAudio ? "is-valid" : "is-missing"}><span>{importedAudio ? <Check size={13} /> : <AlertTriangle size={13} />}</span><b>Voice audio MP3</b><small>{importedAudio ? "Đã xác minh" : "Còn thiếu"}</small></li><li className={importedSubtitles ? "is-valid" : "is-missing"}><span>{importedSubtitles ? <Check size={13} /> : <AlertTriangle size={13} />}</span><b>SRT đồng bộ</b><small>{importedSubtitles ? "Đã kiểm tra" : "Còn thiếu"}</small></li><li className={narrationText.trim() || scriptText.trim() ? "is-valid" : "is-missing"}><span>{narrationText.trim() || scriptText.trim() ? <Check size={13} /> : <AlertTriangle size={13} />}</span><b>Nội dung phân tích</b><small>{narrationText.trim() || scriptText.trim() ? "Đã có" : "Còn thiếu"}</small></li><li className="is-valid"><span><Check size={13} /></span><b>Giọng đọc/TTS</b><small>Đã bỏ qua</small></li></ul>}<div className={`kc-voice-ready-message ${canContinue ? "is-ready" : ""}`}>{canContinue ? <><Check size={14} /> Sẵn sàng để tiếp tục.</> : sourceMode === "imported" ? <><AlertTriangle size={14} /> Cần MP3, SRT đồng bộ và transcript.</> : <><AlertTriangle size={14} /> Cần nội dung thoại và giọng đọc.</>}</div></article>
        </aside>
      </div>

      <footer className="kc-voice-action-bar"><div className="kc-voice-action-left"><button type="button" className="kc-voice-plain-button" disabled={saving} onClick={onBack}><ArrowLeft size={15} /> Quay lại</button><button type="button" className="kc-voice-plain-button" disabled={saving} onClick={() => void continueSetup(false)}><Check size={15} /> Lưu bản nháp</button></div><span>{sourceMode === "imported" ? "MP3 sẽ được dùng trực tiếp; không tạo lại voice." : "Nội dung và cấu hình giọng đọc sẽ được lưu tự động."}</span><button type="button" className="kc-voice-primary-button" disabled={!canContinue} onClick={() => void continueSetup()}>{saving ? "Đang lưu…" : "Lưu và tiếp tục đến Nhân vật"}<ArrowRight size={16} /></button></footer>
      {error && <div className="kc-voice-error" role="alert"><AlertTriangle size={15} /> {error}</div>}
    </section>
  );
}
