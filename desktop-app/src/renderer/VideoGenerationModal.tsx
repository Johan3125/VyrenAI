import { Film, Image as ImageIcon, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  videoModelForProvider,
  type VideoGenerationSettings,
  type VideoGenerationProvider,
} from "../shared/scene-job";
import type { Scene, VisualBible } from "../shared/timeline";

interface VideoGenerationModalProps {
  scene: Scene;
  initialPrompt: string;
  thumbnail?: string;
  visualBible: VisualBible;
  videoProvider: VideoGenerationProvider;
  onClose: () => void;
  onGenerate: (prompt: string, mode: Extract<VideoGenerationSettings["mode"], "text-to-video" | "first-frame">) => void;
}

export function VideoGenerationModal({
  scene,
  initialPrompt,
  thumbnail,
  visualBible,
  videoProvider,
  onClose,
  onGenerate,
}: VideoGenerationModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const hasSourceImage = Boolean(scene.imageResultPath);
  const [mode, setMode] = useState<Extract<VideoGenerationSettings["mode"], "text-to-video" | "first-frame">>(
    "text-to-video",
  );
  const providerName = {
    "google-flow": "Google Flow",
    "gemini-video": "Gemini Video",
    "grok-video": "Grok Video",
    "capcut-video": "CapCut Video Studio",
  }[videoProvider];

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="generation-modal" role="dialog" aria-modal="true" aria-labelledby="video-generation-title">
        <header className="generation-modal-header">
          <div>
            <p className="eyebrow">Scene {scene.order}</p>
            <h3 id="video-generation-title">Tạo video scene</h3>
          </div>
          <button className="icon-button" type="button" title="Đóng" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="generation-settings-strip">
          <div><Film size={16} /><span>Provider</span><strong>{providerName}</strong></div>
          <div><Film size={16} /><span>Model</span><strong>{videoModelForProvider(videoProvider)}</strong></div>
          <div><ImageIcon size={16} /><span>Chế độ</span><strong>{mode === "text-to-video" ? "Prompt trực tiếp" : "Khung hình đầu"}</strong></div>
          <div><Sparkles size={16} /><span>Video</span><strong>16:9 · {scene.durationSeconds} giây</strong></div>
        </div>

        <div className="generation-modal-body">
          <div className="generation-mode-choice" role="group" aria-label="Chọn cách tạo video">
            <button className={mode === "text-to-video" ? "is-selected" : ""} type="button" onClick={() => setMode("text-to-video")}>
              <Film size={15} />
              <span><strong>Tạo trực tiếp</strong><small>Không cần ảnh mở đầu</small></span>
            </button>
            <button className={mode === "first-frame" ? "is-selected" : ""} type="button" disabled={!hasSourceImage} onClick={() => setMode("first-frame")}>
              <ImageIcon size={15} />
              <span><strong>Dùng ảnh scene</strong><small>{hasSourceImage ? "Gắn làm Start frame" : "Chưa có ảnh scene"}</small></span>
            </button>
          </div>

          <div className="video-source-preview">
            <div className="video-source-frame">
              {thumbnail
                ? <img src={thumbnail} alt={`Khung bắt đầu scene ${scene.order}`} />
                : <ImageIcon size={28} />}
            </div>
            <div>
              <strong>{mode === "text-to-video" ? "Prompt trực tiếp sang video" : "Khung hình bắt đầu của video"}</strong>
              <span>{mode === "text-to-video" ? "Google Flow tạo video từ prompt, không cần tạo ảnh trước." : `Dùng ảnh vừa tạo của scene ${scene.order}`}</span>
              <small>{mode === "text-to-video" ? "Không attach source image" : scene.imageResultPath}</small>
            </div>
          </div>

          <label className="field generation-prompt-field">
            <span>Prompt chuyển động video</span>
            <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>

          <div className="attachment-preflight">
            <strong>Worker sẽ tự chuẩn bị chế độ Video trên {providerName}</strong>
            <p>{mode === "text-to-video" ? "Không cần ảnh mở đầu; prompt được gửi trực tiếp vào trình tạo video." : "Ảnh trên được dùng làm khung hình mở đầu. Worker không cộng dồn ảnh từ các scene cũ."}</p>
            <small>Thiết lập: {videoModelForProvider(videoProvider)} · {mode === "text-to-video" ? "Prompt trực tiếp" : "Khung hình đầu"} · 16:9 · {scene.durationSeconds} giây. Visual Bible: {visualBible.style || "chưa thiết lập"}.</small>
          </div>
        </div>

        <footer className="generation-modal-footer">
          <button className="button secondary" type="button" onClick={onClose}>Hủy</button>
          <button
            className="button primary"
            type="button"
            disabled={!prompt.trim() || (mode === "first-frame" && !scene.imageResultPath)}
            onClick={() => onGenerate(prompt.trim(), mode)}
          >
            <Sparkles size={16} /> {mode === "text-to-video" ? "Tạo video trực tiếp" : "Gắn khung hình đầu và tạo video"}
          </button>
        </footer>
      </section>
    </div>
  );
}
