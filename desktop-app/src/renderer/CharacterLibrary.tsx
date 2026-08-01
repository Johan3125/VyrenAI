import {
  ArrowLeft,
  ArrowRight,
  Check,
  Image as ImageIcon,
  ImageUp,
  LockKeyhole,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { normalizeCharacterToken, type CharacterImageInput, type CharacterView } from "../shared/character";

interface EditorState {
  mode: "create" | "edit";
  originalToken: string | null;
  token: string;
  name: string;
  role: string;
  palette: string;
  appearance: string;
  clothing: string;
  isMain: boolean;
  isRecurring: boolean;
  detailsLocked: boolean;
  imageFile: File | null;
  previewUrl: string | null;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Không thể lưu thay đổi.";
  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

async function imageInput(file: File): Promise<CharacterImageInput> {
  return { bytes: await file.arrayBuffer(), mimeType: file.type };
}

const steps = [
  { number: "01", label: "Voice audio & nội dung", state: "done" },
  { number: "02", label: "Nhân vật", state: "active" },
  { number: "03", label: "Visual Bible", state: "locked" },
  { number: "04", label: "Bắt đầu workflow", state: "locked" },
] as const;

export function CharacterLibrary({
  workflowStep = false,
  onContinue,
  onBack,
}: {
  workflowStep?: boolean;
  onContinue?: () => void;
  onBack?: () => void;
}) {
  const [characters, setCharacters] = useState<CharacterView[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bridge = window.flowx;
    if (!bridge) { setLoading(false); return; }
    let active = true;
    void bridge.characters.list().then((items) => {
      if (active) setCharacters(items);
    }).catch((caught) => {
      if (active) setError(errorMessage(caught));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const previewUrl = editor?.previewUrl;
    return () => { if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl); };
  }, [editor?.previewUrl]);

  function openCreate() {
    setError(null);
    setEditor({ mode: "create", originalToken: null, token: "@", name: "", role: "", palette: "", appearance: "", clothing: "", isMain: false, isRecurring: true, detailsLocked: true, imageFile: null, previewUrl: null });
  }

  function openEdit(character: CharacterView) {
    setError(null);
    setEditor({ mode: "edit", originalToken: character.token, token: character.token, name: character.name, role: character.role || "", palette: character.palette || "", appearance: character.appearance || "", clothing: character.clothing || "", isMain: Boolean(character.isMain), isRecurring: Boolean(character.isRecurring), detailsLocked: Boolean(character.detailsLocked), imageFile: null, previewUrl: character.refImageDataUrl });
  }

  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setEditor((current) => current ? { ...current, imageFile: file, previewUrl: URL.createObjectURL(file) } : current);
  }

  async function persistEditor(): Promise<boolean> {
    const bridge = window.flowx;
    if (!bridge || !editor) return false;
    const token = normalizeCharacterToken(editor.token);
    if (!token) { setError("Token chỉ được chứa chữ cái, chữ số hoặc dấu gạch dưới."); return false; }
    if (!editor.name.trim()) { setError("Vui lòng nhập tên nhân vật."); return false; }
    if (editor.mode === "create" && !editor.imageFile) { setError("Vui lòng chọn ảnh tham chiếu."); return false; }
    setSaving(true); setError(null);
    try {
      const nextCharacters = editor.mode === "create" && editor.imageFile
        ? await bridge.characters.create({ token, name: editor.name, image: await imageInput(editor.imageFile), role: editor.role, palette: editor.palette, appearance: editor.appearance, clothing: editor.clothing, isMain: editor.isMain, isRecurring: editor.isRecurring, detailsLocked: editor.detailsLocked })
        : await bridge.characters.update({ originalToken: editor.originalToken!, token, name: editor.name, image: editor.imageFile ? await imageInput(editor.imageFile) : undefined, role: editor.role, palette: editor.palette, appearance: editor.appearance, clothing: editor.clothing, isMain: editor.isMain, isRecurring: editor.isRecurring, detailsLocked: editor.detailsLocked });
      setCharacters(nextCharacters); setEditor(null); setSavedAt(new Date()); return true;
    } catch (caught) { setError(errorMessage(caught)); return false; }
    finally { setSaving(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void persistEditor(); }
  function saveDraft() { if (editor) void persistEditor(); }

  async function removeCharacter(character: CharacterView) {
    const bridge = window.flowx;
    if (!bridge || !window.confirm(`Xóa ${character.token} khỏi thư viện nhân vật?`)) return;
    setError(null);
    try {
      const nextCharacters = await bridge.characters.remove(character.token);
      setCharacters(nextCharacters);
      if (editor?.originalToken === character.token) setEditor(null);
      setSavedAt(new Date());
    } catch (caught) { setError(errorMessage(caught)); }
  }

  const mainCount = characters.filter((item) => item.isMain).length;
  const recurringCount = characters.filter((item) => item.isRecurring).length;
  const lockedCount = characters.filter((item) => item.detailsLocked).length;

  return (
    <section className="kc-character-studio" aria-label="Tạo nhân vật">
      <header className="kc-character-page-header">
        <div>
          <p className="kc-voice-eyebrow">THIẾT LẬP DỰ ÁN</p>
          <h1>Nhân vật</h1>
          <p>Thiết lập nhân vật và khóa các đặc điểm để giữ tính nhất quán cho toàn bộ video.</p>
        </div>
        <div className="kc-character-header-meta">
          <span><i className="kc-status-dot" /> Phiên hiện tại</span>
          <b>{savedAt ? `Đã lưu lúc ${savedAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}` : "Chưa có thay đổi đã lưu"}</b>
        </div>
      </header>

      <nav className="kc-character-stepper" aria-label="Tiến trình thiết lập">
        {steps.map((step, index) => (
          <div className={`kc-character-step is-${step.state}`} key={step.number}>
            <div className="kc-character-step-icon">{step.state === "done" ? <Check size={14} /> : step.state === "locked" ? <LockKeyhole size={13} /> : step.number}</div>
            <div><strong>{step.label}</strong><small>{step.state === "done" ? "Đã hoàn thành" : step.state === "active" ? "Đang thực hiện" : "Chưa mở"}</small></div>
            {index < steps.length - 1 && <span className="kc-character-step-line" />}
          </div>
        ))}
      </nav>

      <div className="kc-character-summary-strip">
        <div><Users size={17} /><span><b>{characters.length}</b> nhân vật</span></div>
        <div><ShieldCheck size={17} /><span><b>{lockedCount}</b> đã khóa</span></div>
        <div><span className="kc-summary-number is-main">{mainCount}</span><span>nhân vật chính</span></div>
        <div><span className="kc-summary-number is-recurring">{recurringCount}</span><span>lặp lại</span></div>
        <button className="kc-character-add-button" type="button" onClick={openCreate}><Plus size={15} /> Thêm nhân vật</button>
      </div>

      <div className="kc-character-layout">
        <div className="kc-character-roster-card">
          <div className="kc-character-card-header"><div><span className="kc-character-card-kicker">CHARACTER LIBRARY</span><h2>Thư viện nhân vật</h2></div><span className="kc-character-count">{characters.length} mục</span></div>
          {loading && <div className="kc-character-empty"><span className="kc-character-loader" /> Đang tải thư viện...</div>}
          {!loading && characters.length === 0 && <div className="kc-character-empty"><Users size={30} /><strong>Chưa có nhân vật</strong><span>Thêm ảnh tham chiếu đầu tiên để dùng lại nhân vật trong các scene.</span><button className="kc-character-outline-button" type="button" onClick={openCreate}><Plus size={14} /> Thêm nhân vật</button><small>Hoặc chọn “Không sử dụng nhân vật” khi câu chuyện không có nhân vật lặp lại.</small></div>}
          <div className="kc-character-list">
            {characters.map((character) => (
              <article className={`kc-character-card ${editor?.originalToken === character.token ? "is-selected" : ""}`} key={character.token}>
                <div className="kc-character-card-image">{character.refImageDataUrl ? <img src={character.refImageDataUrl} alt={character.name} loading="lazy" /> : <ImageIcon size={26} />}</div>
                <div className="kc-character-card-body"><div className="kc-character-card-title"><div><b>{character.token}</b><strong>{character.name}</strong></div><div className="kc-character-card-actions"><button type="button" aria-label={`Sửa ${character.token}`} title="Sửa" onClick={() => openEdit(character)}><Pencil size={14} /></button><button className="is-danger" type="button" aria-label={`Xóa ${character.token}`} title="Xóa" onClick={() => void removeCharacter(character)}><Trash2 size={14} /></button></div></div><span className="kc-character-role">{character.role || "Chưa đặt vai trò"}</span><p>{character.appearance || "Chưa có mô tả ngoại hình"}</p><div className="kc-character-tags">{character.isMain && <span className="is-main">Chính</span>}{character.isRecurring && <span className="is-recurring">Lặp lại</span>}{character.detailsLocked && <span className="is-locked"><LockKeyhole size={10} /> Đã khóa</span>}</div><small className="kc-character-palette">{character.palette || "Chưa có bảng màu"}</small></div>
              </article>
            ))}
          </div>
        </div>

        <div className="kc-character-editor-column">
          {editor ? <form className="kc-character-editor-card" onSubmit={submit}>
            <div className="kc-character-card-header"><div><span className="kc-character-card-kicker">{editor.mode === "create" ? "NEW CHARACTER" : "EDIT CHARACTER"}</span><h2>{editor.mode === "create" ? "Thêm nhân vật" : "Chỉnh sửa nhân vật"}</h2></div><button className="kc-character-close" type="button" aria-label="Đóng trình chỉnh sửa" onClick={() => setEditor(null)}><X size={16} /></button></div>
            <div className="kc-character-upload-zone" onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click(); }}><input ref={fileInputRef} type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={selectImage} hidden />{editor.previewUrl ? <img src={editor.previewUrl} alt="Ảnh tham chiếu nhân vật" /> : <><span><Upload size={22} /></span><strong>Tải ảnh tham chiếu</strong><small>PNG, JPG hoặc WEBP · ảnh rõ khuôn mặt và trang phục</small></>}</div>
            <div className="kc-character-editor-grid">
              <label><span>Token <em>*</em></span><input value={editor.token} onChange={(event) => setEditor({ ...editor, token: event.target.value })} placeholder="@GULLIT" maxLength={41} autoFocus /></label>
              <label><span>Tên nhân vật <em>*</em></span><input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="Tên hiển thị" maxLength={80} /></label>
              <label><span>Vai trò</span><input value={editor.role} onChange={(event) => setEditor({ ...editor, role: event.target.value })} placeholder="Nhân vật chính, người dẫn chuyện..." maxLength={100} /></label>
              <label><span>Bảng màu</span><input value={editor.palette} onChange={(event) => setEditor({ ...editor, palette: event.target.value })} placeholder="Đen, trắng, xanh dương..." maxLength={200} /></label>
              <label className="is-wide"><span>Ngoại hình</span><textarea value={editor.appearance} onChange={(event) => setEditor({ ...editor, appearance: event.target.value })} placeholder="Chiều cao, tỷ lệ, khuôn mặt, tóc và đặc điểm nhận diện..." maxLength={1000} /></label>
              <label className="is-wide"><span>Trang phục & phụ kiện</span><textarea value={editor.clothing} onChange={(event) => setEditor({ ...editor, clothing: event.target.value })} placeholder="Quần áo, phụ kiện và chi tiết không được thay đổi..." maxLength={1000} /></label>
            </div>
            <div className="kc-character-flags"><label><input type="checkbox" checked={editor.isMain} onChange={(event) => setEditor({ ...editor, isMain: event.target.checked })} /> Nhân vật chính</label><label><input type="checkbox" checked={editor.isRecurring} onChange={(event) => setEditor({ ...editor, isRecurring: event.target.checked })} /> Nhân vật lặp lại</label><label><input type="checkbox" checked={editor.detailsLocked} onChange={(event) => setEditor({ ...editor, detailsLocked: event.target.checked })} /> Khóa đặc điểm</label></div>
            <div className="kc-character-editor-actions"><button className="kc-character-outline-button" type="button" onClick={() => fileInputRef.current?.click()}><ImageUp size={14} /> Đổi ảnh</button><button className="kc-character-primary-button" type="submit" disabled={saving}><Save size={14} /> {saving ? "Đang lưu..." : "Lưu nhân vật"}</button></div>
          </form> : <div className="kc-character-editor-empty"><div className="kc-character-editor-empty-icon"><ImageIcon size={26} /></div><h2>Chọn hoặc thêm nhân vật</h2><p>Nhân vật được lưu một lần và có thể tái sử dụng trong mọi prompt tạo ảnh và video.</p><button className="kc-character-primary-button" type="button" onClick={openCreate}><Plus size={15} /> Thêm nhân vật mới</button><div className="kc-character-tip"><ShieldCheck size={15} /><span>Bật <b>Khóa đặc điểm</b> để giữ nguyên khuôn mặt, màu sắc và trang phục giữa các scene.</span></div></div>}
          <div className="kc-character-validation-card"><div><ShieldCheck size={16} /><strong>Kiểm tra bước Nhân vật</strong></div><p>{characters.length ? "Thư viện đã sẵn sàng cho Visual Bible." : "Bạn có thể tiếp tục mà không cần nhân vật nếu câu chuyện không sử dụng nhân vật lặp lại."}</p><span className={characters.length ? "is-valid" : "is-neutral"}>{characters.length ? "Đã kiểm tra" : "Không sử dụng nhân vật"}</span></div>
        </div>
      </div>

      {error && <div className="kc-character-error" role="alert"><X size={15} /> {error}</div>}
      {workflowStep && <footer className="kc-character-action-bar"><div className="kc-character-action-left"><button className="kc-character-plain-button" type="button" onClick={onBack} disabled={!onBack}><ArrowLeft size={14} /> Quay lại</button><button className="kc-character-plain-button" type="button" onClick={saveDraft} disabled={saving || !editor}><Save size={14} /> {saving ? "Đang lưu" : "Lưu bản nháp"}</button></div><span>{editor ? "Lưu nhân vật để cập nhật dữ liệu trước khi tiếp tục." : "Nhân vật và cấu hình khóa sẽ được lưu tự động."}</span><button className="kc-character-primary-button" type="button" disabled={saving || Boolean(editor)} onClick={onContinue}>Tiếp tục đến Visual Bible <ArrowRight size={15} /></button></footer>}
    </section>
  );
}
