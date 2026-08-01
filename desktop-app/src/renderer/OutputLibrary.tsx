import {
  AudioLines,
  CheckCircle2,
  FileJson,
  FileText,
  FolderOpen,
  Image,
  Images,
  ScrollText,
  Shapes,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OutputGroupId, OutputGroupView, OutputInspection } from "../shared/system";
import type { TimelineSession } from "../shared/timeline";

function size(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

const GROUP_COPY: Record<OutputGroupId, { label: string; icon: typeof Image }> = {
  audio: { label: "Audio", icon: AudioLines },
  srt: { label: "SRT", icon: FileText },
  prompts: { label: "Google Flow prompts", icon: ScrollText },
  images: { label: "Ảnh scene", icon: Images },
  videos: { label: "Video scene", icon: Video },
  frames: { label: "Frame nối tiếp", icon: Shapes },
  logs: { label: "Log", icon: ScrollText },
  metadata: { label: "Project metadata", icon: FileJson },
};

function OutputCard({ group, onOpen }: { group: OutputGroupView; onOpen: () => void }) {
  const [preview, setPreview] = useState("");
  const copy = GROUP_COPY[group.id];
  const Icon = copy.icon;
  const firstPath = group.files[0]?.path || "";

  useEffect(() => {
    let active = true;
    if (!firstPath || (group.id !== "images" && group.id !== "frames")) {
      setPreview("");
      return undefined;
    }
    void window.flowx?.media.getStreamUrl(firstPath).then(
      (streamUrl) => { if (active) setPreview(streamUrl); },
      () => { if (active) setPreview(""); },
    );
    return () => { active = false; };
  }, [firstPath, group.id]);

  return (
    <article className="kc-output-card">
      <div className="kc-output-preview">
        {preview ? <img src={preview} alt="Xem trước đầu ra" loading="lazy" /> : <Icon size={21} />}
      </div>
      <div className="kc-output-copy">
        <strong>{copy.label}</strong>
        <span>{group.count} file · {size(group.sizeBytes)}</span>
        <small title={group.path}>{group.path}</small>
      </div>
      <span className={group.count ? "is-valid" : "is-empty"}>
        {group.count ? <CheckCircle2 size={13} /> : null}
        {group.count ? "Hợp lệ" : "Chưa có"}
      </span>
      <button type="button" title={`Mở thư mục ${copy.label}`} onClick={onOpen}>
        <FolderOpen size={16} />
      </button>
    </article>
  );
}

export function OutputLibrary({
  inspection,
  session,
  compact = false,
}: {
  inspection: OutputInspection | null;
  session: TimelineSession | null;
  compact?: boolean;
}) {
  const [openError, setOpenError] = useState("");
  const [exporting, setExporting] = useState(false);
  const virtual = useMemo(() => ({
    visualBible: session
      ? [
        session.visualBible.style,
        session.visualBible.palette,
        session.visualBible.lighting,
        session.visualBible.continuityNotes,
      ].filter(Boolean).length
      : 0,
    prompts: session?.scenes.reduce(
      (count, scene) => count + Number(Boolean(scene.imagePrompt)) + Number(Boolean(scene.videoPrompt)),
      0,
    ) || 0,
  }), [session]);

  const open = async (group?: OutputGroupId) => {
    if (!session || !window.flowx) return;
    const error = await window.flowx.system.openOutput(session.id, group);
    setOpenError(error);
  };

  const exportMetadata = async () => {
    if (!session || !window.flowx) return;
    setExporting(true);
    setOpenError("");
    try {
      await window.flowx.system.exportSession(session);
    } catch (caught) {
      setOpenError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className={`kc-output-library ${compact ? "is-compact" : ""}`}>
      <header>
        <div>
          <span>ĐẦU RA CUỐI CÙNG</span>
          <h2>Thư viện đầu ra</h2>
        </div>
        <div className="kc-output-actions">
          <button type="button" disabled={!session || exporting} onClick={() => void exportMetadata()}>
            <FileJson size={15} /> {exporting ? "Đang xuất" : "Xuất metadata"}
          </button>
          <button type="button" onClick={() => void open()}>
            <FolderOpen size={15} /> Mở thư mục phiên
          </button>
        </div>
      </header>
      <div className="kc-output-grid">
        <article className="kc-output-card is-virtual">
          <div className="kc-output-preview"><Shapes size={21} /></div>
          <div className="kc-output-copy">
            <strong>Visual Bible</strong>
            <span>{virtual.visualBible}/4 nhóm quy tắc</span>
            <small>Lưu trong metadata phiên</small>
          </div>
          <span className={virtual.visualBible ? "is-valid" : "is-empty"}>
            {virtual.visualBible ? "Đã lưu" : "Chưa có"}
          </span>
        </article>
        <article className="kc-output-card is-virtual">
          <div className="kc-output-preview"><FileText size={21} /></div>
          <div className="kc-output-copy">
            <strong>Prompt</strong>
            <span>{virtual.prompts} prompt</span>
            <small>Lưu cùng timeline</small>
          </div>
          <span className={virtual.prompts ? "is-valid" : "is-empty"}>
            {virtual.prompts ? "Đã lưu" : "Chưa có"}
          </span>
        </article>
        {(inspection?.groups || []).map((group) => (
          <OutputCard key={group.id} group={group} onOpen={() => void open(group.id)} />
        ))}
      </div>
      {openError && <p className="kc-inline-error">Không mở được thư mục: {openError}</p>}
    </section>
  );
}
