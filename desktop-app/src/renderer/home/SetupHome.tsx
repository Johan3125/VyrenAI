import {
  ArrowRight,
  BookOpenCheck,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  LoaderCircle,
  Mic2,
  Palette,
  Play,
  Radio,
  UsersRound,
} from "lucide-react";
import { useState } from "react";
import {
  isImportedVoiceAudioSource,
  type TimelineSession,
} from "../../shared/timeline";
import type { WorkerStatuses } from "../../shared/worker-status";
import {
  IMAGE_PROVIDER_LABEL,
  IMAGE_PROVIDER_WORKER_ROLE,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
  VIDEO_PROVIDER_LABEL,
  VIDEO_PROVIDER_WORKER_ROLE,
  type ProviderImageProvider,
  type ProviderVideoProvider,
  type TextProvider,
} from "../../shared/provider";
import type { AppPage } from "../app-navigation";
import { HOME_MODE_LABELS, readHomeCharactersReviewed } from "../home-workflow-state";
import type { HomeWorkflowMode } from "../integrated-workflow";
import { type HomeCharacterSummary, setupSteps, sourceReady } from "./homepage-model";

function dateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Chưa có dữ liệu" : parsed.toLocaleString("vi-VN");
}

function srtStats(text: string): { cues: number; duration: string } {
  const matches = [...text.matchAll(/(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/g)];
  const end = matches.at(-1);
  return {
    cues: matches.length,
    duration: end ? `${end[5]}:${end[6]}:${end[7]}` : "Chưa phân tích",
  };
}

const STEP_ICONS = { source: FileText, characters: UsersRound, "visual-bible": Palette, start: Play } as const;

export function SetupHome({
  session,
  mode,
  characters,
  workers,
  textProvider,
  imageProvider,
  videoProvider,
  onNavigate,
  onStart,
}: {
  session: TimelineSession;
  mode: HomeWorkflowMode;
  characters: HomeCharacterSummary;
  workers: WorkerStatuses;
  textProvider: TextProvider;
  imageProvider: ProviderImageProvider;
  videoProvider: ProviderVideoProvider;
  onNavigate: (page: AppPage) => void;
  onStart: () => Promise<boolean>;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const quickScript = mode === "script_to_media";
  const reviewed = quickScript || readHomeCharactersReviewed(session.id);
  const steps = setupSteps(session, mode, reviewed);
  const sourceDone = sourceReady(session, mode);
  const bibleDone = quickScript || Boolean(session.visualBible.style.trim());
  const textWorkerRole = TEXT_PROVIDER_WORKER_ROLE[textProvider];
  const textProviderLabel = TEXT_PROVIDER_LABEL[textProvider];
  const textWorker = workers[textWorkerRole];
  const textWorkerReady = textWorker?.connected === true;
  const outputTarget = session.workflowSource.outputTarget || "video";
  const videoSourceMode = session.workflowSource.videoSourceMode || "direct";
  const imageRequired = mode === "full_auto" ||
    (quickScript && (outputTarget === "images" || (outputTarget === "video" && videoSourceMode === "image-first")));
  const videoRequired = mode === "full_auto" || (quickScript && outputTarget === "video");
  const imageWorkerRole = IMAGE_PROVIDER_WORKER_ROLE[imageProvider];
  const videoWorkerRole = VIDEO_PROVIDER_WORKER_ROLE[videoProvider];
  const imageWorker = workers[imageWorkerRole];
  const videoWorker = workers[videoWorkerRole];
  const imageReady = imageWorker?.connected === true;
  const videoReady = videoWorker?.connected === true;
  const setupReady = sourceDone && reviewed && bibleDone;
  const canStart = setupReady && textWorkerReady &&
    (!imageRequired || imageReady) &&
    (!videoRequired || videoReady) &&
    !starting;
  const stats = srtStats(session.workflowSource.srtText);
  const importedVoiceAudio = isImportedVoiceAudioSource(session.workflowSource);
  const next = !sourceDone
    ? { label: quickScript ? "Tiếp tục nhập kịch bản" : "Tiếp tục nhập nội dung & chọn giọng", page: quickScript ? "timeline" : "voice" as AppPage }
    : !reviewed
      ? { label: "Tiếp tục đến Nhân vật", page: "characters" as AppPage }
      : !bibleDone
        ? { label: "Tiếp tục đến Visual Bible", page: "visual-bible" as AppPage }
        : !canStart
          ? { label: "Kiểm tra kết nối worker", page: "settings" as AppPage }
          : null;
  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    setStartError("");
    try {
      if (!await onStart()) setStartError("Không thể bắt đầu workflow. Hãy kiểm tra thông báo hệ thống.");
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="kc-home-setup-v2">
      <header className="kc-home-setup-session">
        <span><LoaderCircle size={21} /></span>
        <div><small>PHIÊN ĐANG THIẾT LẬP</small><h2>{session.name}</h2><p><Clock3 size={12} /> Lưu gần nhất {dateLabel(session.savedAt)}</p></div>
        <div><b>{HOME_MODE_LABELS[mode]}</b><span className="kc-home-status is-info">Đang thiết lập</span><small><Check size={11} /> Dữ liệu lưu theo phiên</small></div>
      </header>

      <section className="kc-home-setup-layout">
        <div className="kc-home-setup-main">
          <section className="kc-home-stepper-v2" aria-label="Tiến trình thiết lập">
            {steps.map((step, index) => {
              const Icon = STEP_ICONS[step.id];
              return <article key={step.id} className={`is-${step.status}`}><header><span>{step.status === "completed" ? <Check size={14} /> : step.status === "error" ? <CircleAlert size={14} /> : <Icon size={14} />}</span><small>BƯỚC {index + 1}</small></header><strong>{step.title}</strong><p>{step.description}</p><b>{step.status === "completed" ? "Đã hoàn thành" : step.status === "in-progress" ? "Đang thực hiện" : step.status === "error" ? "Có lỗi" : "Chưa thực hiện"}</b>{index < steps.length - 1 && <i aria-hidden="true" />}</article>;
            })}
          </section>

          <section className="kc-home-setup-summary">
            <article>
              <header><span><Mic2 size={16} /></span><div><small>{quickScript ? "SCRIPT TO MEDIA" : "VOICE STUDIO"}</small><strong>{quickScript ? "Kịch bản → Media" : importedVoiceAudio ? "MP3 & SRT có sẵn" : "Nội dung & giọng đọc"}</strong></div><b className={sourceDone ? "is-ready" : "is-missing"}>{sourceDone ? "Đã sẵn sàng" : "Còn thiếu"}</b></header>
              <dl>{quickScript ? <><div><dt>Kịch bản</dt><dd>{session.workflowSource.scriptFileName || (session.workflowSource.scriptText.trim() ? "Nội dung đã dán" : "Chưa nhập")}</dd></div><div><dt>Đầu ra</dt><dd>{outputTarget === "video" ? "Video hoàn chỉnh" : outputTarget === "images" ? "Storyboard ảnh" : "Chỉ tạo prompt"}</dd></div><div><dt>Timeline</dt><dd>{session.workflowSource.timingOrigin === "user_srt" ? "Theo SRT đã chọn" : "Tự động từ kịch bản"}</dd></div><div><dt>Nhịp</dt><dd>{session.workflowSource.pacing === "quick" ? "Nhanh" : session.workflowSource.pacing === "cinematic" ? "Điện ảnh" : "Cân bằng"}</dd></div></> : importedVoiceAudio ? <><div><dt>Voice MP3</dt><dd>{session.workflowSource.audioFileName || "Chưa chọn"}</dd></div><div><dt>Thời lượng</dt><dd>{session.workflowSource.audioDurationSeconds ? `${Math.round(session.workflowSource.audioDurationSeconds)} giây` : "Đã xác minh"}</dd></div><div><dt>Giọng đọc</dt><dd>Không sử dụng TTS</dd></div><div><dt>SRT</dt><dd>{session.workflowSource.srtFileName || "Chưa chọn"}</dd></div><div><dt>Subtitle</dt><dd>{stats.cues || "—"}</dd></div><div><dt>Transcript</dt><dd>{session.workflowSource.narrationText?.trim() ? "Đã có" : "Còn thiếu"}</dd></div></> : <><div><dt>Nội dung thoại</dt><dd>{session.workflowSource.narrationText?.trim() ? "Đã có" : "Chưa có"}</dd></div><div><dt>Tên nội dung</dt><dd>{session.workflowSource.narrationFileName || "Nội dung đã dán"}</dd></div><div><dt>Giọng đọc</dt><dd>{session.workflowSource.voiceName || "Chưa chọn"}</dd></div><div><dt>Ngôn ngữ</dt><dd>{session.workflowSource.voiceName?.split("-").slice(0, 2).join("-") || "—"}</dd></div><div><dt>Audio</dt><dd>{session.workflowSource.audioFileName || "Chưa tạo"}</dd></div><div><dt>SRT</dt><dd>{session.workflowSource.srtFileName || "Chưa tạo"}</dd></div></>}</dl>{!quickScript && !session.workflowSource.audioFileName && <p>{importedVoiceAudio ? "Hãy chọn MP3 và SRT đồng bộ trong Voice Studio." : "Audio và SRT sẽ được tạo khi bắt đầu workflow."}</p>}
            </article>

            <article>
              <header><span><UsersRound size={16} /></span><div><small>CHARACTER SYSTEM</small><strong>{quickScript ? "Phân tích nhân vật tự động" : "Nhân vật"}</strong></div><b className={reviewed ? "is-ready" : "is-missing"}>{quickScript ? "Tự động" : reviewed ? "Đã kiểm tra" : "Chưa kiểm tra"}</b></header>
              <dl><div><dt>Thư viện</dt><dd>{characters.total} nhân vật</dd></div><div><dt>Nhân vật chính</dt><dd>{characters.main}</dd></div><div><dt>Nhân vật lặp lại</dt><dd>{characters.recurring}</dd></div><div><dt>Sử dụng</dt><dd>{quickScript ? "Tự khớp tên xuất hiện trong kịch bản" : characters.total ? "Có nhân vật" : "Không sử dụng nhân vật"}</dd></div></dl>
            </article>

            <article>
              <header><span><BookOpenCheck size={16} /></span><div><small>CONSISTENCY SYSTEM</small><strong>Visual Bible</strong></div><b className={bibleDone ? "is-ready" : "is-missing"}>{quickScript && !session.visualBible.style.trim() ? "Tự động" : bibleDone ? "Đã khóa" : "Còn thiếu"}</b></header>
              <dl><div><dt>Phong cách</dt><dd>{session.visualBible.style.trim() ? "Đã nhập" : quickScript ? "Tự phân tích từ nội dung" : "Chưa nhập"}</dd></div><div><dt>Ảnh tham khảo</dt><dd>{session.styleReference ? session.styleReference.name : "Không có"}</dd></div><div><dt>Tỷ lệ</dt><dd>{session.visualBible.aspectRatio || "16:9"}</dd></div><div><dt>Cập nhật</dt><dd>{dateLabel(session.savedAt)}</dd></div></dl>
            </article>

            <article className="is-workers">
              <header><span><Radio size={16} /></span><div><small>WORKER READINESS</small><strong>Sẵn sàng bắt đầu</strong></div><b className={canStart ? "is-ready" : "is-missing"}>{canStart ? "Sẵn sàng" : "Chưa sẵn sàng"}</b></header>
              <dl><div><dt>{textProviderLabel} Text</dt><dd className={textWorkerReady ? "is-connected" : "is-disconnected"}>{textWorkerReady ? "Đã kết nối" : "Mất kết nối"}</dd></div><div><dt>{IMAGE_PROVIDER_LABEL[imageProvider]}</dt><dd className={imageReady ? "is-connected" : "is-disconnected"}>{imageReady ? "Đã kết nối" : imageRequired ? "Bắt buộc kết nối" : "Không cần cho đầu ra này"}</dd></div><div><dt>{VIDEO_PROVIDER_LABEL[videoProvider]}</dt><dd className={videoReady ? "is-connected" : "is-disconnected"}>{videoReady ? "Đã kết nối" : videoRequired ? "Bắt buộc kết nối" : "Không cần cho đầu ra này"}</dd></div><div><dt>Text profile</dt><dd>{textWorker?.profileTag || "Chưa đăng ký"}</dd></div><div><dt>Media profile</dt><dd>{videoWorker?.profileTag || imageWorker?.profileTag || "Chưa đăng ký"}</dd></div></dl>
            </article>
          </section>
        </div>

        <aside className="kc-home-next-action">
          <span>{canStart ? <Play size={22} /> : <ArrowRight size={22} />}</span><small>HÀNH ĐỘNG TIẾP THEO</small><h3>{next?.label || "Bắt đầu toàn bộ workflow"}</h3><p>{canStart ? "Các bước bắt buộc và worker đã sẵn sàng." : "Homepage đã chọn công việc chưa hoàn thành đầu tiên của phiên."}</p>
          {next ? <button className="button primary" type="button" onClick={() => onNavigate(next.page)}>{next.label}<ArrowRight size={15} /></button> : <button className="button primary" type="button" disabled={!canStart} onClick={() => void start()}>{starting ? <><LoaderCircle className="spin" size={15} /> Đang bắt đầu…</> : <><Play size={15} /> Bắt đầu toàn bộ workflow</>}</button>}
          {startError && <p className="form-error">{startError}</p>}
        </aside>
      </section>
    </div>
  );
}
