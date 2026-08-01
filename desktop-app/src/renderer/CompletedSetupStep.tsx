import {
  CheckCircle2,
  Clapperboard,
  FileAudio,
  Palette,
  RotateCcw,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import {
  isImportedVoiceAudioSource,
  type TimelineSession,
} from "../shared/timeline";

export type CompletedSetupStepKind = "voice" | "characters" | "visual-bible";

const STEP_COPY: Record<CompletedSetupStepKind, {
  title: string;
  description: string;
  consequence: string;
  icon: typeof FileAudio;
}> = {
  voice: {
    title: "Voice & SRT đã hoàn thành",
    description: "Nội dung thoại và cấu hình âm thanh của phiên đã được dùng để tạo kịch bản cảnh.",
    consequence: "Nếu thay đổi nội dung hoặc giọng đọc, bạn cần chạy lại bước Bắt đầu để cập nhật âm thanh, phụ đề và kịch bản cảnh.",
    icon: FileAudio,
  },
  characters: {
    title: "Bước Nhân vật đã hoàn thành",
    description: "Nhân vật đã được kiểm tra và gán vào các cảnh liên quan.",
    consequence: "Nếu thay đổi ảnh hoặc thông tin nhân vật, hãy tạo lại kịch bản cảnh để cập nhật các câu lệnh liên quan.",
    icon: UsersRound,
  },
  "visual-bible": {
    title: "Visual Bible đã hoàn thành",
    description: "Phong cách đồ họa của phiên đã được khóa trước khi tạo kịch bản cảnh.",
    consequence: "Nếu thay đổi Visual Bible, câu lệnh cũ không tự đổi. Bạn cần tạo lại kịch bản cảnh theo phong cách vừa cập nhật.",
    icon: Palette,
  },
};

function compact(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  return text.length > 92 ? `${text.slice(0, 89)}…` : text;
}

export function CompletedSetupStep({
  kind,
  session,
  phase3Running = false,
  onKeep,
  onRedo,
}: {
  kind: CompletedSetupStepKind;
  session: TimelineSession;
  phase3Running?: boolean;
  onKeep: () => void;
  onRedo: () => void;
}) {
  const copy = STEP_COPY[kind];
  const Icon = copy.icon;
  const characterTokens = new Set(
    session.scenes.flatMap((scene) => scene.assignedCharacterTokens || scene.usedCharacterTokens || []),
  );
  const details = kind === "voice"
    ? [
      ["Nguồn voice", isImportedVoiceAudioSource(session.workflowSource)
        ? "MP3 có sẵn · bỏ qua TTS"
        : session.workflowSource.voiceName || "Chưa chọn giọng"],
      ["Audio", session.workflowSource.audioFileName || "Đã lưu cấu hình, chưa có file"],
      ["SRT", session.workflowSource.srtFileName || "Đã lưu trong hồ sơ phiên"],
      ["Timeline", `${session.scenes.length} scene đã tạo`],
    ]
    : kind === "characters"
      ? [
        ["Nhân vật đã gán", characterTokens.size ? `${characterTokens.size} nametag` : "Không có nhân vật lặp lại"],
        ["Scene có nhân vật", `${session.scenes.filter((scene) => (scene.assignedCharacterTokens || scene.usedCharacterTokens || []).length > 0).length}/${session.scenes.length} scene`],
        ["Kịch bản", `${session.scenes.length} scene đã phân tích`],
        ["Trạng thái", "Đã hoàn thành"],
      ]
      : [
        ["Phong cách", compact(session.visualBible.style, "Chưa có phong cách")],
        ["Bảng màu", compact(session.visualBible.palette, "Không khóa bảng màu riêng")],
        ["Tỷ lệ", session.visualBible.aspectRatio || "16:9"],
        ["Kịch bản", `${session.scenes.length} prompt scene đã tạo`],
      ];
  const visibleDetails = phase3Running
    ? details.map(([label, value]) => [label, label === "Timeline" || label === "Kịch bản" ? "Đang tạo…" : value])
    : details;

  return (
    <section className="kc-completed-step" aria-labelledby={`completed-${kind}-title`}>
      <div className="kc-completed-step-icon"><Icon size={30} /><CheckCircle2 size={19} /></div>
      <header>
        <p className="eyebrow">{phase3Running ? "WORKFLOW ĐANG CHẠY" : "BƯỚC ĐÃ HOÀN THÀNH"}</p>
        <h2 id={`completed-${kind}-title`}>{phase3Running ? "Dữ liệu bước này đã được khóa" : copy.title}</h2>
        <p>{phase3Running ? "Vyren AI đang dùng dữ liệu đã lưu của bước này để tạo kịch bản và câu lệnh cho từng cảnh. Form nhập được ẩn để tránh thay đổi dữ liệu giữa lúc xử lý." : copy.description}</p>
      </header>
      <div className="kc-completed-step-details">
        {visibleDetails.map(([label, value]) => <article key={label}><small>{label}</small><strong title={value}>{value}</strong></article>)}
      </div>
      <div className="kc-completed-step-warning">
        <ShieldCheck size={18} />
        <div><strong>{phase3Running ? "Không thể sửa trong khi workflow đang chạy" : "Bạn có cần tạo lại bước này không?"}</strong><span>{phase3Running ? "Hãy dừng workflow trước nếu thực sự cần thay đổi dữ liệu đầu vào." : copy.consequence}</span></div>
      </div>
      <footer>
        <button className="button primary" type="button" onClick={onKeep}><Clapperboard size={15} /> Mở tiến trình và quản lý scene</button>
        <button className="button danger" type="button" disabled={phase3Running} title={phase3Running ? "Hãy dừng workflow trước khi sửa lại bước này" : "Mở lại form để tạo lại dữ liệu"} onClick={onRedo}><RotateCcw size={15} /> Có, mở để tạo lại</button>
      </footer>
    </section>
  );
}
