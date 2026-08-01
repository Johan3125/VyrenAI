import {
  Check,
  Clipboard,
  Image as ImageIcon,
  ImageUp,
  Info,
  Lock,
  LockOpen,
  Palette,
  RefreshCcw,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import type { CharacterView } from "../shared/character";
import { MAX_STYLE_REFERENCE_BYTES, type TimelineStyleReference, type VisualBible } from "../shared/timeline";
import type { GraphicStylePreset } from "../shared/visual-style";

export interface ConsistencyLockItem { key: string; label: string; enabled: boolean; }

interface VisualBiblePanelProps {
  value: VisualBible;
  initialValue?: VisualBible;
  onChange: (value: VisualBible) => void;
  presets: GraphicStylePreset[];
  presetError: string;
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  styleReference: TimelineStyleReference | null;
  onStyleReferenceChange: (reference: TimelineStyleReference | null) => void;
  locks?: ConsistencyLockItem[];
  onToggleLock?: (key: string) => void;
  characters?: CharacterView[];
  onOpenCharacters?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function referenceBytes(reference: TimelineStyleReference): number {
  const payload = reference.dataUrl.split(",")[1] || "";
  return Math.round(payload.length * 0.75);
}

export function VisualBiblePanel({ value, initialValue = value, onChange, presets, presetError, onSavePreset, onDeletePreset, styleReference, onStyleReferenceChange, locks = [], onToggleLock, characters = [], onOpenCharacters }: VisualBiblePanelProps) {
  const [presetName, setPresetName] = useState("");
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [referenceSize, setReferenceSize] = useState<{ width: number; height: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const update = (field: keyof VisualBible, next: string) => onChange({ ...value, [field]: next });
  const selectedPreset = presets.find((preset) => preset.style === value.style);
  const lockedCount = locks.filter((lock) => lock.enabled).length;
  const mainCharacters = characters.filter((character) => character.isMain).length;
  const recurringCharacters = characters.filter((character) => character.isRecurring).length;
  const lockedCharacters = characters.filter((character) => character.detailsLocked).length;

  useEffect(() => {
    if (!styleReference) { setReferenceSize(null); return; }
    const image = new Image();
    image.onload = () => setReferenceSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = styleReference.dataUrl;
    return () => { image.onload = null; };
  }, [styleReference]);

  function readReference(file: File) {
    setReferenceError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setReferenceError("Ảnh mẫu phải là PNG, JPEG hoặc WebP."); return; }
    if (file.size > MAX_STYLE_REFERENCE_BYTES) { setReferenceError("Ảnh mẫu vượt quá giới hạn 8 MB."); return; }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => { setUploading(false); onStyleReferenceChange({ name: file.name, mimeType: file.type as TimelineStyleReference["mimeType"], dataUrl: String(reader.result || "") }); };
    reader.onerror = () => { setUploading(false); setReferenceError("Không đọc được ảnh mẫu."); };
    reader.readAsDataURL(file);
  }

  function dropReference(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) readReference(file);
  }

  return (
    <div className="kc-vb-main-grid">
      <div className="kc-vb-left-column">
        <section className="kc-vb-card kc-vb-style-card">
          <header><span className="kc-vb-card-number">04</span><div><p>RENDER CONFIGURATION</p><h2><Palette size={16} /> Phong cách đồ họa</h2></div><b className="kc-vb-required">Bắt buộc</b></header>
          <div className="kc-vb-card-body">
            <p className="kc-vb-description">Phong cách này được gửi nguyên văn vào Google Flow. AI phân tích prompt không được tự ý thay đổi phong cách.</p>
            <div className="kc-vb-field-header"><label htmlFor="kc-vb-style">Phong cách đồ họa gửi Google Flow <em>*</em></label><div><button type="button" title="Sao chép" aria-label="Sao chép phong cách" onClick={() => void navigator.clipboard.writeText(value.style).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}><Clipboard size={13} /> {copied ? "Đã chép" : "Sao chép"}</button><button type="button" title="Khôi phục lúc mở trang" onClick={() => update("style", initialValue.style)}><RefreshCcw size={13} /> Khôi phục</button><button className="is-danger" type="button" title="Xóa phong cách" onClick={() => { if (value.style && window.confirm("Xóa nội dung phong cách đồ họa hiện tại?")) update("style", ""); }}><Trash2 size={13} /> Xóa</button></div></div>
            <textarea id="kc-vb-style" className={!value.style.trim() ? "is-invalid" : ""} value={value.style} maxLength={2400} placeholder="Ví dụ: Stickman, flat 2D illustration, white background, clean bold black outlines, thick line art..." onChange={(event) => update("style", event.target.value)} aria-required="true" />
            <div className="kc-vb-field-meta"><span className={!value.style.trim() ? "is-error" : "is-valid"}>{value.style.trim() ? <><Check size={12} /> Phong cách đã hợp lệ</> : <><X size={12} /> Hãy nhập phong cách đồ họa</>}</span><small>{value.style.length}/2400 ký tự</small></div>
            <div className="kc-vb-info-box"><Info size={15} /><span>Prompt scene chỉ mô tả nhân vật, hành động, biểu cảm, bối cảnh, góc máy và chuyển động. Phong cách đồ họa được ghép riêng khi gửi Google Flow.</span></div>
          </div>
        </section>

        <section className="kc-vb-card kc-vb-preset-card">
          <header><span className="kc-vb-card-number">05</span><div><p>LOCAL PRESETS</p><h2>Phong cách đã lưu trên máy</h2></div><span className="kc-vb-count-badge">{presets.length} preset</span></header>
          <div className="kc-vb-card-body">
            <div className="kc-vb-preset-row"><label><span>Preset hiện tại</span><select value={selectedPreset?.id || ""} onChange={(event) => { const preset = presets.find((item) => item.id === event.target.value); if (preset) update("style", preset.style); }}><option value="">Tùy chỉnh chưa lưu</option>{presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}{preset.builtIn ? " · Mặc định" : ""}</option>)}</select></label><button className="is-apply" type="button" disabled={!selectedPreset} onClick={() => selectedPreset && update("style", selectedPreset.style)}>Áp dụng</button><button type="button" onClick={() => setShowPresetEditor((current) => !current)}><Save size={13} /> Lưu hiện tại</button><button className="is-danger" type="button" disabled={!selectedPreset || selectedPreset.builtIn} onClick={() => selectedPreset && onDeletePreset(selectedPreset.id)}><Trash2 size={13} /></button></div>
            {showPresetEditor && <div className="kc-vb-preset-save"><input value={presetName} maxLength={80} placeholder="Tên phong cách mới" onChange={(event) => setPresetName(event.target.value)} autoFocus /><button type="button" disabled={!presetName.trim() || !value.style.trim()} onClick={() => { onSavePreset(presetName.trim()); setPresetName(""); setShowPresetEditor(false); }}>Lưu preset</button><button type="button" onClick={() => setShowPresetEditor(false)}>Hủy</button></div>}
            {!presets.length && <div className="kc-vb-inline-empty">Chưa có phong cách nào được lưu trên máy.</div>}
            {presetError && <small className="kc-vb-inline-error">{presetError}</small>}
          </div>
        </section>

        <section className="kc-vb-card kc-vb-reference-card">
          <header><span className="kc-vb-card-number">06</span><div><p>STYLE REFERENCE</p><h2><ImageIcon size={16} /> Ảnh tham khảo phong cách</h2></div><span className="kc-vb-optional">Tùy chọn</span></header>
          <div className="kc-vb-card-body"><p className="kc-vb-description">Ảnh chỉ giúp ChatGPT hiểu cách trình bày và tính nhất quán. Ảnh không thay thế phong cách chữ đã nhập.</p><div className="kc-vb-reference-layout">
            {styleReference ? <div className="kc-vb-reference-current"><div className="kc-vb-reference-image"><img src={styleReference.dataUrl} alt="Ảnh tham khảo phong cách" /></div><div><strong title={styleReference.name}>{styleReference.name}</strong><span><Check size={12} /> Đã sẵn sàng cho ChatGPT</span><small>{styleReference.mimeType.replace("image/", "").toUpperCase()} · {formatBytes(referenceBytes(styleReference))}{referenceSize ? ` · ${referenceSize.width}×${referenceSize.height}` : ""}</small><div><button type="button" onClick={() => fileInputRef.current?.click()}><ImageUp size={13} /> Thay ảnh</button><button className="is-danger" type="button" onClick={() => { if (window.confirm("Xóa ảnh tham khảo phong cách?")) onStyleReferenceChange(null); }}><Trash2 size={13} /> Xóa</button></div></div></div> : <div className="kc-vb-reference-empty"><ImageIcon size={25} /><strong>Chưa có ảnh tham khảo</strong><span>Đây là nội dung tùy chọn.</span></div>}
            <div className={`kc-vb-drop-zone ${uploading ? "is-uploading" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={dropReference} onClick={() => !uploading && fileInputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !uploading) fileInputRef.current?.click(); }}><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) readReference(file); }} />{uploading ? <span className="kc-vb-loader" /> : <Upload size={22} />}<strong>{uploading ? "Đang xử lý ảnh..." : "Kéo ảnh vào đây hoặc chọn từ máy"}</strong><small>PNG, JPEG, WebP · Tối đa 8 MB</small><button type="button" disabled={uploading}>Chọn ảnh mẫu</button></div>
          </div>{referenceError && <div className="kc-vb-upload-error"><X size={13} /> {referenceError}</div>}</div>
        </section>
      </div>

      <div className="kc-vb-right-column">
        <section className="kc-vb-card kc-vb-color-card">
          <header><span className="kc-vb-card-number">07</span><div><p>ART DIRECTION</p><h2>Quy tắc màu sắc và ánh sáng</h2></div></header>
          <div className="kc-vb-dual-fields"><label><span>Bảng màu dự án</span><textarea value={value.palette} maxLength={800} placeholder="Nền trắng, nét đen đậm, xanh dương làm màu nhấn..." onChange={(event) => update("palette", event.target.value)} /><small>{value.palette.length}/800 ký tự</small><div><button type="button" onClick={() => update("palette", initialValue.palette)}><RefreshCcw size={12} /> Khôi phục</button><button className="is-danger" type="button" onClick={() => update("palette", "")}><Trash2 size={12} /> Xóa</button></div></label><label><span>Ánh sáng</span><textarea value={value.lighting} maxLength={800} placeholder="Ánh sáng ban ngày dịu, bóng đổ tối thiểu..." onChange={(event) => update("lighting", event.target.value)} /><small>{value.lighting.length}/800 ký tự</small><div><button type="button" onClick={() => update("lighting", initialValue.lighting)}><RefreshCcw size={12} /> Khôi phục</button><button className="is-danger" type="button" onClick={() => update("lighting", "")}><Trash2 size={12} /> Xóa</button></div></label></div>
          <div className="kc-vb-light-note"><Info size={13} /> Prompt scene chỉ thay đổi ánh sáng khi câu chuyện thực sự yêu cầu.</div>
        </section>

        <section className="kc-vb-card kc-vb-ratio-card"><header><span className="kc-vb-card-number">08</span><div><p>OUTPUT FORMAT</p><h2>Tỷ lệ khung hình</h2></div><span className="kc-vb-locked-badge"><Lock size={11} /> Đã khóa</span></header><div className="kc-vb-ratio-body"><span className="kc-vb-ratio-shape">16:9</span><div><strong>16:9 · Ngang</strong><small>Tất cả ảnh và video trong phiên sử dụng cùng tỷ lệ 16:9.</small></div></div></section>

        <section className="kc-vb-card kc-vb-continuity-card"><header><span className="kc-vb-card-number">09</span><div><p>CROSS-SCENE MEMORY</p><h2>Nhân vật, bối cảnh và quy tắc liên tục</h2></div></header><div className="kc-vb-card-body"><textarea value={value.continuityNotes.split(`\n\nVYREN CONSISTENCY LOCKS:`)[0]} maxLength={3000} placeholder="Thiết kế nhân vật, trang phục, tỷ lệ cơ thể, địa điểm lặp lại, đạo cụ, hướng di chuyển..." onChange={(event) => { const lockBlock = value.continuityNotes.includes("VYREN CONSISTENCY LOCKS:") ? `\n\nVYREN CONSISTENCY LOCKS:${value.continuityNotes.split("VYREN CONSISTENCY LOCKS:")[1]}` : ""; update("continuityNotes", `${event.target.value}${lockBlock}`); }} /><div className="kc-vb-field-meta"><span>Đây là bộ nhớ xuyên scene, không phải mô tả phong cách vẽ.</span><small>{value.continuityNotes.split(`\n\nVYREN CONSISTENCY LOCKS:`)[0].length}/3000</small></div></div></section>

        {locks.length > 0 && <section className="kc-vb-card kc-vb-lock-card"><header><span className="kc-vb-card-number">10</span><div><p>CONSISTENCY SYSTEM</p><h2>Bộ khóa tính nhất quán</h2></div><span className="kc-vb-count-badge">{lockedCount}/7 đang bật</span></header><div className="kc-vb-lock-grid">{locks.map((lock) => <button className={lock.enabled ? "is-enabled" : ""} type="button" aria-pressed={lock.enabled} key={lock.key} onClick={() => onToggleLock?.(lock.key)} disabled={!onToggleLock}>{lock.enabled ? <Lock size={14} /> : <LockOpen size={14} />}<span>{lock.label}<small>{lock.enabled ? "Đang bật" : "Đang tắt"}</small></span></button>)}</div></section>}

        <section className="kc-vb-card kc-vb-summary-card"><header><span className="kc-vb-card-number">11</span><div><p>VALIDATION</p><h2>Tóm tắt Visual Bible</h2></div></header><div className="kc-vb-summary-content"><ul><li className={value.style.trim() ? "is-valid" : "is-error"}>{value.style.trim() ? <Check size={12} /> : <X size={12} />}<span>Phong cách đồ họa</span><b>{value.style.trim() ? "Đã nhập" : "Bắt buộc"}</b></li><li className="is-valid"><Check size={12} /><span>Ảnh tham khảo</span><b>{styleReference ? "Đã thêm" : "Không sử dụng"}</b></li><li className={value.palette.trim() ? "is-valid" : "is-warning"}>{value.palette.trim() ? <Check size={12} /> : <Info size={12} />}<span>Bảng màu</span><b>{value.palette.trim() ? "Đã nhập" : "Tùy chọn"}</b></li><li className={value.lighting.trim() ? "is-valid" : "is-warning"}>{value.lighting.trim() ? <Check size={12} /> : <Info size={12} />}<span>Ánh sáng</span><b>{value.lighting.trim() ? "Đã nhập" : "Tùy chọn"}</b></li><li className="is-valid"><Check size={12} /><span>Tỷ lệ khung hình</span><b>16:9</b></li><li className="is-valid"><ShieldCheck size={12} /><span>Quy tắc khóa</span><b>{lockedCount}/7</b></li></ul><div className={value.style.trim() ? "is-ready" : "is-blocked"}><strong>{lockedCount}/7</strong><span>{value.style.trim() ? "Visual Bible đã sẵn sàng" : "Cần nhập phong cách đồ họa"}</span></div></div></section>

        <section className="kc-vb-card kc-vb-character-summary"><header><span className="kc-vb-card-number">12</span><div><p>READ-ONLY SUMMARY</p><h2><Users size={15} /> Nhân vật liên quan</h2></div></header>{characters.length ? <div className="kc-vb-character-stats"><div><b>{characters.length}</b><span>Tổng nhân vật</span></div><div><b>{mainCharacters}</b><span>Nhân vật chính</span></div><div><b>{recurringCharacters}</b><span>Lặp lại</span></div><div><b>{lockedCharacters}/{characters.length}</b><span>Đã khóa</span></div></div> : <div className="kc-vb-inline-empty">Phiên này không sử dụng nhân vật lặp lại.</div>}<div className="kc-vb-character-actions"><button type="button" onClick={onOpenCharacters} disabled={!onOpenCharacters}>Quay lại chỉnh sửa nhân vật</button></div></section>
      </div>
    </div>
  );
}
