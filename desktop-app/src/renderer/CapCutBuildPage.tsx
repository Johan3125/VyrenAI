import { CheckCircle2, Clapperboard, Film, Volume2 } from "lucide-react";
import type { TimelineSession } from "../shared/timeline";

export function CapCutBuildPage({ session, onBuild }: { session: TimelineSession | null; onBuild: () => void }) {
  const scenes = session?.scenes || [];
  const completed = scenes.filter((scene) => scene.videoStatus === "done" && Boolean(scene.videoResultPath)).length;
  const hasVoice = Boolean(session?.workflowSource?.audioPath);
  const ready = scenes.length > 0 && completed === scenes.length;
  return (
    <section className="kc-capcut-launch-page">
      <div className="kc-capcut-launch-card">
        <div className="kc-capcut-launch-icon"><Clapperboard size={28} /></div>
        <div className="kc-capcut-launch-copy">
          <small>DỰNG VIDEO CUỐI CÙNG</small>
          <h1>Dựng vào project CapCut</h1>
          <p>Chọn project CapCut đích, sau đó Vyren AI sẽ xếp toàn bộ video scene theo đúng thứ tự timeline. Bạn có thể giữ voice/audio project hoặc dùng audio gốc từ từng clip Google Flow.</p>
        </div>
        <button className="button primary kc-capcut-launch-button" type="button" disabled={!ready} onClick={onBuild}>
          <Clapperboard size={16} /> Tạo trên CapCut
        </button>
      </div>
      <div className="kc-capcut-launch-stats">
        <article><Film size={17} /><span>Video scene</span><strong>{completed}/{scenes.length}</strong><small>{ready ? "Đã sẵn sàng" : "Cần đủ 100% scene"}</small></article>
        <article><Volume2 size={17} /><span>Âm thanh</span><strong>{hasVoice ? "Voice/project" : "Audio gốc clip"}</strong><small>{hasVoice ? "Có thể giữ voice CapCut" : "Phù hợp ASMR, không cần voice"}</small></article>
        <article><CheckCircle2 size={17} /><span>Đầu ra</span><strong>60 FPS</strong><small>MP4 · H.264 · AAC</small></article>
      </div>
      {!ready && <p className="kc-capcut-launch-warning">Cần hoàn thành toàn bộ video scene trước khi tạo timeline CapCut.</p>}
    </section>
  );
}
