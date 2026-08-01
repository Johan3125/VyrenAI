import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  HardDrive,
  RadioTower,
  RefreshCcw,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { APP_BRAND_NAME, EXTENSION_DISPLAY_NAME } from "../shared/brand";
import {
  DEFAULT_PROVIDER_SETTINGS,
  IMAGE_PROVIDER_LABEL,
  IMAGE_PROVIDER_URL,
  IMAGE_PROVIDER_WORKER_ROLE,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
  VIDEO_PROVIDER_LABEL,
  VIDEO_PROVIDER_URL,
  VIDEO_PROVIDER_WORKER_ROLE,
  type ProviderImageProvider,
  type ProviderSettings,
  type ProviderSettingsInput,
  type ProviderVideoProvider,
  type TextProvider,
} from "../shared/provider";
import {
  VOICE_PROVIDER_LABEL,
  type VoiceProvider,
} from "../shared/voice";
import type { SystemStatus } from "../shared/system";
import {
  createDisconnectedWorkerStatus,
  type WorkerConnectionStatus,
  type WorkerRole,
  type WorkerStatuses,
} from "../shared/worker-status";

const WORKER_LABELS: Record<WorkerRole, string> = {
  "chat-worker": "ChatGPT Worker",
  "flow-worker": "Google Flow Worker",
  "claude-worker": "Claude Worker",
  "gemini-worker": "Gemini Worker",
  "grok-worker": "Grok Worker",
  "capcut-worker": "CapCut Worker",
};

const TEXT_PROVIDER_URL: Record<TextProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  gemini: "https://gemini.google.com/app",
  grok: "https://grok.com/",
};

const VOICE_PROVIDER_URL: Partial<Record<VoiceProvider, string>> = {
  "capcut-web": "https://www.capcut.com/vi-vn/tools/ai-voice-over",
};

function workerStatusLabel(worker: WorkerConnectionStatus): string {
  if (!worker.connected) return "Chưa kết nối";
  const connectedCount = worker.connectedCount || 1;
  if (connectedCount <= 1) return "Đã kết nối";
  const idleCount = worker.idleCount ?? Math.max(0, connectedCount - (worker.busyCount || 0));
  return `Đã kết nối · ${idleCount}/${connectedCount} slot rảnh`;
}

export function SettingsView({
  workers,
  system,
  onRefresh,
}: {
  workers: WorkerStatuses;
  system: SystemStatus | null;
  onRefresh: () => void;
}) {
  const [extensionMessage, setExtensionMessage] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [pendingStorageRoot, setPendingStorageRoot] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerMessage, setProviderMessage] = useState("");

  useEffect(() => {
    let active = true;
    const loadProviderSettings = async () => {
      try {
        const settings = await window.flowx?.providerSettings.get();
        if (active && settings) setProviderSettings(settings);
      } catch (error) {
        if (active) {
          setProviderMessage(error instanceof Error ? error.message : "Kh\u00F4ng th\u1EC3 t\u1EA3i c\u1EA5u h\u00ECnh provider.");
        }
      } finally {
        if (active) setProviderLoading(false);
      }
    };
    void loadProviderSettings();
    return () => {
      active = false;
    };
  }, []);

  const saveProvider = async (input: ProviderSettingsInput) => {
    const bridge = window.flowx?.providerSettings;
    if (!bridge || providerSaving) return;
    setProviderSaving(true);
    setProviderMessage("\u0110ang l\u01B0u...");
    try {
      setProviderSettings(await bridge.save(input));
      window.dispatchEvent(new Event("vyren-provider-settings-changed"));
      setProviderMessage("\u0110\u00E3 l\u01B0u");
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : "Kh\u00F4ng th\u1EC3 l\u01B0u c\u1EA5u h\u00ECnh provider.");
    } finally {
      setProviderSaving(false);
    }
  };
  const openExtensionFolder = async () => {
    const error = await window.flowx?.system.openExtensionFolder();
    setExtensionMessage(
      error || `Đã mở thư mục ${EXTENSION_DISPLAY_NAME}. Trong Chrome, hãy chọn Tải tiện ích đã giải nén và chọn thư mục này.`,
    );
  };
  const openStorage = async (target: "root" | "data" | "outputs") => {
    const error = await window.flowx?.system.openStorage(target);
    setStorageMessage(error || "Đã mở thư mục lưu trữ trên máy.");
  };
  const selectStorage = async () => {
    const result = await window.flowx?.system.selectStorage();
    if (!result?.selected) return;
    if (!result.restartRequired) {
      setStorageMessage("Thư mục này đang được sử dụng.");
      return;
    }
    setPendingStorageRoot(result.rootPath);
    setStorageMessage(`Đã chọn ${result.rootPath}. Hãy khởi động lại để chuyển dữ liệu.`);
  };
  const restart = () => {
    if (!window.confirm(`Khởi động lại ${APP_BRAND_NAME} và chuyển dữ liệu sang nơi lưu mới?`)) return;
    void window.flowx?.system.restart();
  };
  const activeWorkerRoles = [...new Set([
    TEXT_PROVIDER_WORKER_ROLE[providerSettings.textProvider],
    IMAGE_PROVIDER_WORKER_ROLE[providerSettings.imageProvider],
    VIDEO_PROVIDER_WORKER_ROLE[providerSettings.videoProvider],
  ])] as WorkerRole[];
  const activeProviderLinks = [
    {
      label: TEXT_PROVIDER_LABEL[providerSettings.textProvider],
      url: TEXT_PROVIDER_URL[providerSettings.textProvider],
    },
    {
      label: IMAGE_PROVIDER_LABEL[providerSettings.imageProvider],
      url: IMAGE_PROVIDER_URL[providerSettings.imageProvider],
    },
    {
      label: VIDEO_PROVIDER_LABEL[providerSettings.videoProvider],
      url: VIDEO_PROVIDER_URL[providerSettings.videoProvider],
    },
    {
      label: VOICE_PROVIDER_LABEL[providerSettings.voiceProvider],
      url: VOICE_PROVIDER_URL[providerSettings.voiceProvider],
    },
  ].filter((entry): entry is { label: string; url: string } => Boolean(entry.url))
    .filter((entry, index, entries) =>
      entries.findIndex((candidate) => candidate.url === entry.url) === index
  );

  return (
    <section className="kc-settings-view">
      <header className="kc-section-heading">
        <div>
          <span>CẤU HÌNH</span>
          <h2>Kết nối & lưu trữ</h2>
          <p>{APP_BRAND_NAME} dùng extension Chrome cục bộ để điều khiển các tab AI đã đăng nhập.</p>
        </div>
        <button type="button" onClick={onRefresh}><RefreshCcw size={14} /> Làm mới</button>
      </header>

      <div className="kc-settings-grid">
        {activeWorkerRoles.map((role) => {
          const worker = workers[role] || createDisconnectedWorkerStatus(role);
          return (
          <article key={worker.role}>
            <div className={`kc-settings-icon ${worker.connected ? "is-online" : ""}`}><RadioTower size={19} /></div>
            <div>
              <strong>{WORKER_LABELS[worker.role]}</strong>
              <span>{workerStatusLabel(worker)}</span>
              <small>{worker.profileTag || "Chưa nhận diện tab trình duyệt"}</small>
            </div>
            {worker.connected && <CheckCircle2 size={17} />}
          </article>
          );
        })}
      </div>

      <div className="kc-provider-center">
        <header>
          <div>
            <SlidersHorizontal size={18} />
            <div>
              <strong>Nền tảng AI</strong>
              <span>Chọn dịch vụ dùng để viết nội dung, tạo voice, tạo ảnh và tạo video.</span>
            </div>
          </div>
          <small>{providerLoading ? "\u0110ang t\u1EA3i..." : providerMessage || "\u0110\u00E3 s\u1EB5n s\u00E0ng"}</small>
        </header>
        <div className="kc-provider-controls">
          <label>
            <span>Vi&#7871;t l&#7841;i &amp; prompt</span>
            <select
              value={providerSettings.textProvider}
              disabled={providerLoading || providerSaving}
              onChange={(event) => void saveProvider({ textProvider: event.target.value as TextProvider })}
            >
              <option value="chatgpt">ChatGPT</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="grok">Grok</option>
            </select>
          </label>
          <label>
            <span>T&#7841;o voice</span>
            <select
              value={providerSettings.voiceProvider}
              disabled={providerLoading || providerSaving}
              onChange={(event) => void saveProvider({
                voiceProvider: event.target.value as VoiceProvider,
              })}
            >
              <option value="edge">{VOICE_PROVIDER_LABEL.edge}</option>
              <option value="capcut-web">{VOICE_PROVIDER_LABEL["capcut-web"]} (Experimental)</option>
              <option value="imported">{VOICE_PROVIDER_LABEL.imported}</option>
            </select>
          </label>
          <label>
            <span>T&#7841;o &#7843;nh</span>
            <select
              value={providerSettings.imageProvider}
              disabled={providerLoading || providerSaving}
              onChange={(event) => void saveProvider({
                imageProvider: event.target.value as ProviderImageProvider,
              })}
            >
              <option value="google-flow">Google Flow</option>
              <option value="chatgpt-image">ChatGPT Image</option>
              <option value="grok-image">Grok Image (Thử nghiệm)</option>
              <option value="gemini-image">Gemini Image (Thử nghiệm)</option>
            </select>
          </label>
          <label>
            <span>T&#7841;o video</span>
            <select
              value={providerSettings.videoProvider}
              disabled={providerLoading || providerSaving}
              onChange={(event) => void saveProvider({
                videoProvider: event.target.value as ProviderVideoProvider,
              })}
            >
              <option value="google-flow">Google Flow</option>
              <option value="grok-video">Grok Video (Thử nghiệm)</option>
              <option value="gemini-video">Gemini Video (Thử nghiệm)</option>
              <option value="capcut-video">CapCut Video Studio (Thử nghiệm)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="kc-extension-setup kc-storage-setup">
        <div>
          <strong>Lưu trữ tập trung</strong>
          <span>Dữ liệu dự án và media đầu ra được tách khỏi ổ hệ thống. Máy có ổ D mặc định dùng D:\Vyren AI.</span>
        </div>
        <div className="kc-storage-paths">
          <p><b>Thư mục gốc</b><code>{system?.storageRoot || "Đang kiểm tra…"}</code></p>
        </div>
        <div className="kc-storage-actions">
          <button type="button" disabled={!system} onClick={() => void selectStorage()}><HardDrive size={14} /> Chọn nơi lưu</button>
          <button type="button" disabled={!system} onClick={() => void openStorage("root")}><FolderOpen size={14} /> Mở thư mục gốc</button>
        </div>
        {pendingStorageRoot && <button className="kc-storage-restart" type="button" onClick={restart}><RefreshCcw size={14} /> Khởi động lại và chuyển dữ liệu</button>}
        {storageMessage && <p>{storageMessage}</p>}
      </div>

      <div className="kc-extension-setup">
        <div><strong>{EXTENSION_DISPLAY_NAME} Extension</strong><span>Được đóng gói cùng ứng dụng. Chrome vẫn yêu cầu xác nhận cài đặt một lần.</span></div>
        <ol>
          <li>Mở <code>chrome://extensions</code>.</li>
          <li>Bật <b>Chế độ dành cho nhà phát triển</b>.</li>
          <li>Chọn <b>Tải tiện ích đã giải nén</b> và chọn thư mục {EXTENSION_DISPLAY_NAME} vừa mở.</li>
        </ol>
        <button type="button" onClick={() => void openExtensionFolder()}><FolderOpen size={14} /> Mở thư mục Extension</button>
        {extensionMessage && <p>{extensionMessage}</p>}
      </div>

      {!system?.ffmpegAvailable && (
        <div className="kc-ffmpeg-notice">
          <div><strong>Cần FFmpeg để trích frame cuối</strong><span>Cài FFmpeg riêng từ nguồn chính thức, sau đó khởi động lại {APP_BRAND_NAME}.</span></div>
          <button type="button" onClick={() => window.open("https://ffmpeg.org/download.html", "_blank")}><ExternalLink size={14} /> Trang tải FFmpeg</button>
        </div>
      )}

      <div className="kc-settings-help">
        <p>Chỉ cần mở và đăng nhập các nền tảng đang được chọn trong Chrome đã cài extension.</p>
        <div>
          {activeProviderLinks.map((provider) => (
            <button
              key={provider.label}
              type="button"
              onClick={() => window.open(provider.url, "_blank")}
            >
              <ExternalLink size={14} /> Mở {provider.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
