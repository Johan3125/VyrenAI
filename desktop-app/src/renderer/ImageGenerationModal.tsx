import {
  Check,
  Image as ImageIcon,
  Palette,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { CharacterView } from "../shared/character";
import {
  imageModelForProvider,
  type ImageGenerationProvider,
} from "../shared/scene-job";
import type { CharacterPolicy, Scene, VisualBible } from "../shared/timeline";

interface ImageGenerationModalProps {
  scene: Scene;
  initialPrompt: string;
  characters: CharacterView[];
  visualBible: VisualBible;
  imageProvider: ImageGenerationProvider;
  onClose: () => void;
  onGenerate: (value: {
    prompt: string;
    characterPolicy: CharacterPolicy;
    characterTokens: string[];
  }) => void;
}

export function ImageGenerationModal({
  scene,
  initialPrompt,
  characters,
  visualBible,
  imageProvider,
  onClose,
  onGenerate,
}: ImageGenerationModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [policy, setPolicy] = useState<CharacterPolicy>(scene.characterPolicy);
  const [tokens, setTokens] = useState(scene.assignedCharacterTokens);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const toggleCharacter = (token: string) => {
    setPolicy("selected");
    setTokens((current) => current.includes(token)
      ? current.filter((entry) => entry !== token)
      : current.length < 4
        ? [...current, token]
        : current);
  };

  const selectedCharacters = characters.filter((character) =>
    policy === "selected" && tokens.includes(character.token),
  );
  const missingTokens = policy === "selected"
    ? tokens.filter((token) => !characters.some((character) => character.token === token))
    : [];
  const canGenerate = Boolean(prompt.trim()) && missingTokens.length === 0 &&
    (policy === "none" || selectedCharacters.length > 0);
  const providerName = {
    "google-flow": "Google Flow",
    "chatgpt-image": "ChatGPT Image",
    "gemini-image": "Gemini Image",
    "grok-image": "Grok Image",
  }[imageProvider];
  const modelName = imageModelForProvider(imageProvider);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="generation-modal" role="dialog" aria-modal="true" aria-labelledby="image-generation-title">
        <header className="generation-modal-header">
          <div>
            <p className="eyebrow">Scene {scene.order}</p>
            <h3 id="image-generation-title">Chuẩn bị tạo ảnh</h3>
          </div>
          <button className="icon-button" type="button" title="Đóng" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="generation-settings-strip">
          <div><ImageIcon size={16} /><span>Provider</span><strong>{providerName}</strong></div>
          <div><Sparkles size={16} /><span>Model</span><strong>{modelName}</strong></div>
          <div><Palette size={16} /><span>Tỷ lệ</span><strong>{visualBible.aspectRatio}</strong></div>
          <div><Sparkles size={16} /><span>Kết quả</span><strong>1 ảnh</strong></div>
        </div>

        <div className="generation-modal-body">
          <label className="field generation-prompt-field">
            <span>Prompt ảnh</span>
            <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>

          <div className="generation-section">
            <div className="generation-section-title">
              <div><UserRound size={17} /><strong>Nhân vật trong scene</strong></div>
              <span>Tối đa 4 ảnh tham chiếu</span>
            </div>
            <div className="character-policy-options">
              <button type="button" className={policy === "none" ? "is-selected" : ""} onClick={() => { setPolicy("none"); setTokens([]); }}>
                Không có nhân vật
              </button>
              <button type="button" className={policy === "selected" ? "is-selected" : ""} onClick={() => setPolicy("selected")}>
                Chọn từ thư viện
              </button>
            </div>

            {policy === "selected" && (
              characters.length > 0 ? (
                <div className="character-reference-grid">
                  {characters.map((character) => {
                    const selected = tokens.includes(character.token);
                    return (
                      <button
                        key={character.token}
                        type="button"
                        className={`character-reference-card ${selected ? "is-selected" : ""}`}
                        disabled={!selected && tokens.length >= 4}
                        onClick={() => toggleCharacter(character.token)}
                      >
                        <div className="character-reference-image">
                          {character.refImageDataUrl
                            ? <img src={character.refImageDataUrl} alt="" />
                            : <UserRound size={22} />}
                          {selected && <span><Check size={12} /></span>}
                        </div>
                        <strong>{character.name}</strong>
                        <small>{character.token}</small>
                      </button>
                    );
                  })}
                </div>
              ) : <p className="inline-warning">Chưa có nhân vật trong thư viện.</p>
            )}
            {missingTokens.length > 0 && <p className="inline-warning">Không tìm thấy {missingTokens.join(", ")} trong thư viện.</p>}
          </div>

          <div className="generation-section visual-bible-preview">
            <div className="generation-section-title">
              <div><Palette size={17} /><strong>Visual Bible sẽ được chèn vào prompt</strong></div>
            </div>
            <dl>
              <div><dt>Phong cách đồ họa</dt><dd>{visualBible.style || "Chưa thiết lập"}</dd></div>
              <div><dt>Bảng màu</dt><dd>{visualBible.palette || "Chưa thiết lập"}</dd></div>
              <div><dt>Ánh sáng</dt><dd>{visualBible.lighting || "Chưa thiết lập"}</dd></div>
              <div><dt>Liên tục</dt><dd>{visualBible.continuityNotes || "Chưa thiết lập"}</dd></div>
            </dl>
          </div>

          <div className="attachment-preflight">
            <strong>{providerName} worker sẽ đính kèm ảnh tham chiếu trước khi gửi prompt</strong>
            {selectedCharacters.length > 0
              ? <div>{selectedCharacters.map((character) => <span key={character.token}><Check size={12} />{character.token}</span>)}</div>
              : <p>Scene này được xác nhận không dùng ảnh nhân vật.</p>}
            <small>Kết quả sẽ được tải về cùng thư mục phiên và dùng làm ảnh đầu vào cho provider video đã chọn.</small>
          </div>
        </div>

        <footer className="generation-modal-footer">
          <button className="button secondary" type="button" onClick={onClose}>Hủy</button>
          <button
            className="button primary"
            type="button"
            disabled={!canGenerate}
            onClick={() => onGenerate({
              prompt: prompt.trim(),
              characterPolicy: policy,
              characterTokens: policy === "selected" ? tokens : [],
            })}
          >
            <Sparkles size={16} /> Tạo bằng {providerName}
          </button>
        </footer>
      </section>
    </div>
  );
}
