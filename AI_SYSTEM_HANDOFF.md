# Vyren AI — Ghi chú hệ thống dành cho AI tiếp quản

> Cập nhật theo mã nguồn tại workspace ngày 2026-07-20. Đây là tài liệu định hướng nhanh cho AI/developer tiếp theo. Khi tài liệu và mã nguồn khác nhau, ưu tiên theo thứ tự: **type/model dùng chung → service/IPC hiện tại → test → tài liệu này → README lịch sử**.

## 1. Mục tiêu sản phẩm

Vyren AI là ứng dụng desktop tự động hóa quy trình tạo video AI từ nội dung thoại, SRT hoặc kịch bản:

```text
Nội dung/SRT
  → Voice + SRT (nếu dùng chế độ có Voice)
  → Nhân vật
  → Visual Bible
  → ChatGPT chia Timeline và viết prompt
  → Google Flow hoặc ChatGPT Image tạo ảnh
  → Google Flow tạo video
  → trích frame cuối để nối cảnh
  → kiểm tra đầu ra
  → dựng video trong CapCut
```

Ứng dụng không gọi API ChatGPT hoặc Google Flow để sinh nội dung. Electron điều phối công việc; extension Chrome thao tác trên giao diện ChatGPT và Google Flow bằng tài khoản người dùng đang đăng nhập.

Tên sản phẩm hiển thị: **Vyren AI**. Extension: **Vyren AI Worker**. Đơn vị phát triển: **Vyren AI**.

## 2. Cấu trúc repository

```text
flow-continuity-studio/
├─ desktop-app/          Electron + React + TypeScript, ứng dụng chính
├─ extension-worker/     Chrome Manifest V3, worker ChatGPT và Google Flow
├─ vyren-ai-flow/        Extension Google Flow độc lập, tách khỏi Vyren AI Worker chính
├─ PROTOCOL.md           Hợp đồng WebSocket app ↔ extension
├─ README.md             Lịch sử các phase và hướng dẫn tổng quan
└─ AI_SYSTEM_HANDOFF.md  File đang đọc
```

Không tạo project mới và không thay thế framework hiện tại.

## 3. Kiến trúc runtime

### Desktop

- Electron main: `desktop-app/src/main/index.ts`.
- Preload/IPC bridge: `desktop-app/src/preload/index.ts`.
- React entry và điều phối route/state: `desktop-app/src/renderer/src.tsx`.
- Shared model, channel và validator: `desktop-app/src/shared/`.
- UI dùng React 19, TypeScript, CSS thuần và `lucide-react`.
- Build bằng `electron-vite`; đóng gói Windows bằng `electron-builder`/NSIS.

Luồng dữ liệu chính:

```text
React renderer
  ↕ window.flowx (contextBridge)
Electron IPC handlers
  ↕
LowDB session store + SQLite production queue + local file services
  ↕
WorkerServer ws://127.0.0.1:17890
  ↕
Vyren AI Worker extension trong Chrome
  ├─ chat-worker → ChatGPT
  └─ flow-worker → Google Flow
```

Electron bật `contextIsolation`, tắt `nodeIntegration` và bật sandbox. Không đưa filesystem hoặc Node API trực tiếp vào renderer; mọi thao tác phải qua bridge/IPC có type.

### Extension

- Manifest: `extension-worker/manifest.json`, hiện tại version **2.64.0**.
- `worker-connection.js`: WebSocket, REGISTER, heartbeat, reconnect.
- `background.js`: điều phối tab, debugger input, download và job lifecycle.
- `content-chat.js`: vận hành các provider dạng chat/composer: ChatGPT, Claude, Gemini, Grok và CapCut Video Studio.
- `content-flow.js`: thao tác DOM Google Flow để đổi Image/Video, upload ảnh, dán prompt, render và download.

Extension được cài bằng `chrome://extensions` → Developer mode → **Load unpacked** → chọn thư mục `extension-worker/`. Bản đóng gói app cũng chép extension vào resource `vyren-ai-extension`.

### Worker protocol

- Endpoint duy nhất: `ws://127.0.0.1:17890`.
- Chỉ bind `127.0.0.1`, không mở ra LAN.
- Các role hiện tại: `chat-worker`, `claude-worker`, `gemini-worker`, `grok-worker`, `flow-worker`, `capcut-worker`.
- Desktop giữ một pool socket cho mỗi role. Mỗi socket tương ứng một tab provider và chỉ xử lý **một job tại một thời điểm**.
- Extension gắn `profileTag` theo tab dạng `profile-xxxx:tab-123`, nên một Chrome profile có thể chạy nhiều tab worker song song nếu đã reload extension mới.
- REGISTER phải là message đầu tiên; app dùng PING/PONG và heartbeat để phát hiện mất kết nối.
- Không đổi message contract tùy tiện; xem `PROTOCOL.md` và model ở `desktop-app/src/shared/`.

## 4. Ba chế độ khởi tạo phiên

UI có ba lựa chọn:

| Home mode | Session workflowMode | Ý nghĩa |
| --- | --- | --- |
| `full_auto` | `automatic` | Nhập thoại/giọng, chuẩn bị nhân vật và Visual Bible; khi bấm Start cuối cùng, app tạo Voice/SRT, Timeline/Prompt rồi chạy sản xuất |
| `srt_script` | `two_step` | Dùng SRT + kịch bản có sẵn, bỏ qua tạo Voice |
| `step_by_step` | `two_step` | Chuẩn bị theo từng bước và chủ động kiểm tra trước khi sản xuất |

`TimelineSession.workflowMode` hiện chỉ có `automatic` và `two_step`. Lựa chọn chi tiết trên Home được lưu tạm theo session trong localStorage với prefix:

- `vyren-ai.session-home-mode.v1:`
- `vyren-ai.session-characters-reviewed.v1:`

Đây là giới hạn model hiện tại. Không tạo thêm flag trùng lặp nếu chưa thiết kế migration/persistence chính thức.

## 5. Quy trình setup đúng

Với chế độ tự động có Voice:

```text
Chọn mode
  → Nội dung thoại + chọn/cấu hình giọng
  → Nhân vật (tạo hoặc xác nhận không dùng)
  → Visual Bible (phong cách đồ họa bắt buộc)
  → Bắt đầu toàn bộ workflow
```

Điểm quan trọng:

- Ở bước Voice chỉ **lưu input và cài đặt**, nút phải là **Tiếp tục**, không tạo audio ngay.
- Nút **Bắt đầu** chỉ xuất hiện ở bước cuối sau Visual Bible.
- Khi Start cuối được bấm, `TimelineImport` tạo Voice/SRT nếu phiên có `narrationText + voiceName` nhưng chưa có SRT.
- Nếu không có kịch bản hình ảnh riêng, narration text được dùng làm script.
- Sau đó app gọi ChatGPT worker để lập beat/timeline và prompt.
- Kết quả Phase 3 được lưu trước; chế độ automatic mới tiếp tục Production Queue.
- Nếu Google Flow chưa kết nối, Timeline/Prompt vẫn phải được lưu và queue chờ; không được làm mất kết quả Phase 3.
- Khi Phase 3 đã hoàn thành, mở lại Voice/Nhân vật/Visual Bible phải hiển thị cảnh báo bước đã hoàn thành và hỏi người dùng có muốn tạo/sửa lại hay không.

Với chế độ SRT + kịch bản, Homepage không được hiển thị form Voice hoặc bắt người dùng tạo audio.

## 6. Homepage hiện tại

Homepage phải render **đúng một** trong ba trạng thái loại trừ nhau. Logic nguồn nằm ở `desktop-app/src/renderer/home/homepage-model.ts`:

```text
Không có session hoặc chưa có Home mode → new-session
Đã có mode nhưng session chưa có scene     → setup-in-progress
Session đã có scene                         → production-dashboard
```

Các component:

- `desktop-app/src/renderer/DashboardView.tsx`: chọn view theo trạng thái.
- `desktop-app/src/renderer/home/NewSessionHome.tsx`.
- `desktop-app/src/renderer/home/SetupHome.tsx`.
- `desktop-app/src/renderer/home/ProductionHome.tsx`.
- `desktop-app/src/renderer/home/HomeDialog.tsx`.
- `desktop-app/src/renderer/home/homepage-model.ts` và test.
- `desktop-app/src/renderer/WorkflowProgressDock.tsx`: dock tiến trình ngoài route, kéo/thu gọn được và chỉ hiện khi workflow running/paused.

Bất biến UX của Homepage:

- Phiên chưa chọn mode: chỉ thông tin phiên và ba mode.
- Phiên đang setup: chỉ stepper, summary và **một CTA tiếp theo**.
- Phiên đã có Phase 3: chỉ dashboard sản xuất rút gọn.
- Không đặt Voice form, Character editor, Visual Bible editor, full Timeline, full Queue hay Output Library trên Homepage.
- Không hiển thị lại mode selector sau khi phiên đã chọn mode.
- Progress Dock không được biến mất khi đổi trang.

## 7. Voice và SRT

- Service: `desktop-app/src/main/voice-service.ts`.
- IPC: `voice-ipc.ts`, shared types ở `shared/voice.ts`.
- UI: `VoiceWorkflow.tsx`.
- Engine hiện tại: `edge-tts-universal` dùng Microsoft Edge online TTS.
- TTS cần mạng và không có SLA chính thức.
- FFmpeg/FFprobe phải có trên `PATH` để ghép đoạn dài, thêm khoảng nghỉ và đồng bộ timing SRT.
- Output Voice/SRT dùng tên file duy nhất để tránh ghi đè file đang bị Windows/Chrome khóa (`EBUSY`).

Không thay thế phần TTS đang hoạt động bằng mock hoặc engine khác nếu không có yêu cầu rõ ràng.

## 8. Nhân vật và Visual Bible

### Nhân vật

- UI: `CharacterLibrary.tsx`.
- Store: `main/character-store.ts`.
- IPC/model: `character-ipc.ts`, `shared/character.ts`.
- Ảnh tham chiếu PNG/JPEG/WebP, giới hạn theo validator hiện có.
- Token chuẩn hóa dạng `@TEN_NHAN_VAT`, nhưng hệ thống còn đối chiếu tên nhân vật tự nhiên/nametag trong nội dung.
- Mỗi scene dùng assignment nhân vật rõ ràng; không lấy việc prompt có token hay không làm nguồn sự thật duy nhất.
- Khi nhân vật xuất hiện trong prompt ảnh đầu tiên, Flow phải attach ảnh nhân vật. Sau khi marker ingredient đã xuất hiện, không upload lặp lại trong cùng composer/job.

### Visual Bible

- UI: `VisualBibleWorkspace.tsx`, `VisualBiblePanel.tsx`.
- Preset/style store: `main/visual-style-store.ts`.
- `visualBible.style`/phong cách đồ họa là trường bắt buộc trước Start.
- Ảnh phong cách tham khảo là tùy chọn và được gửi ở batch ChatGPT đầu tiên để phân tích.
- ChatGPT chỉ viết nội dung có thể nhìn thấy: nhân vật, hành động, biểu cảm, bối cảnh, vật thể, camera và chuyển động.
- ChatGPT **không được tự thêm, viết lại hoặc thay đổi phong cách đồ họa trong từng prompt scene**.
- Phong cách đồ họa được giữ riêng trong Visual Bible và chỉ ghép vào prompt cuối khi gửi Google Flow.

Mục đích của quy tắc trên là ngăn style thay đổi giữa các scene và tránh ChatGPT làm mất style do diễn đạt lại.

## 9. Phase 3 — chia timeline và viết prompt

Nguồn chính:

- UI/orchestration: `renderer/TimelineImport.tsx`.
- IPC: `main/timeline-ipc.ts`.
- Validation/model: `shared/timeline.ts`.
- Chat worker: `extension-worker/content-chat.js`.

Quy tắc bắt buộc:

- Tỷ lệ toàn dự án: **16:9**.
- Scene chỉ có thời lượng **4, 6 hoặc 8 giây**.
- Timeline phải liên tục, đúng thứ tự và không tự thay đổi boundary ở batch viết prompt.
- ChatGPT chạy beat planning trên toàn bộ SRT/kịch bản trước, sau đó viết prompt theo batch nhỏ.
- Không viết prompt theo từng câu subtitle; gộp thành cảnh hợp lý nhưng vẫn giữ boundary đã khóa.
- Prompt chỉ mô tả thứ khán giả nhìn thấy, không chép lời thoại và không kể chung chung.
- Prompt cần sát câu chuyện: ai xuất hiện, hành động, biểu cảm, bối cảnh, thời điểm, vật thể, camera và chuyển động.
- `continue` phải có `imagePrompt` rỗng; chỉ cần video prompt mô tả hành động tiếp theo từ frame cuối scene trước.

## 10. Scene chain và continuity — bất biến quan trọng

`Scene.chainRole` có ba giá trị:

### `single`

- Cảnh độc lập.
- Tạo ảnh mở đầu riêng rồi dùng ảnh đó làm Start frame để tạo video.
- Không nối dependency giả với scene trước/sau.

### `start`

- Mở đầu một chain mới.
- Tạo ảnh mở đầu riêng rồi tạo video.
- Video hoàn thành có thể cung cấp frame cuối cho scene `continue` kế tiếp cùng chain.

### `continue`

- Không tạo ảnh scene mới.
- Phải đứng ngay sau scene cùng `chainId` và scene trước không được là `single`.
- App tải video scene trước, dùng FFmpeg lấy frame tại **0,05 giây trước điểm kết thúc** (`-sseof -0.05`).
- PNG đó trở thành `startFrameAssetPath`/Start frame của Flow cho scene continue.
- Flow chỉ nhận Start frame; End frame để trống.
- Video prompt phải mô tả chuyển động tiếp tục từ trạng thái nhìn thấy trong Start frame.
- Nếu frame trước chưa tồn tại/hợp lệ, scene continue phải bị blocked và không được dispatch.

Nếu tạo lại video upstream, phải xóa/invalidate frame cuối và video continue cũ ở phía sau trong cùng chain, rồi chạy lại theo thứ tự. Không được nhảy qua scene continue đang thiếu dependency.

## 11. Google Flow automation

Cấu hình sản xuất hiện tại:

- Image model: `nano-banana-pro`, 16:9, 1 output, expected 0 credits.
- Video model: `veo-3.1-lite`, 16:9, 4/6/8s, 1 output, expected 0 credits.
- Video dùng chế độ Frames/Start frame cho quy trình hiện tại.
- `single`/`start`: ảnh vừa tạo là opening frame.
- `continue`: frame cuối đã trích từ video trước là opening frame.

Không hard-code toàn bộ Radix ID kiểu `#radix-:r123:` vì phần giữa thay đổi sau mỗi lần mở popup. Selector phải ưu tiên:

1. role/aria/data-state;
2. text hiển thị (`Video`, `Hình ảnh`, `Khung hình`, `16:9`, `4s`, `6s`, `8s`);
3. material icon;
4. suffix ổn định như `trigger-4` kết hợp text chính xác `4s`.

Không nhầm duration `4s` với tùy chọn output `x4`.

Với attachment nhân vật, marker material-symbol `cancel` trên thumbnail là bằng chứng Flow đã nhận ingredient. Sau marker này, dán prompt và gửi; không upload lặp vô hạn.

Video download chỉ dùng **một kênh native Google Flow**. Extension click Download đúng một lần, theo dõi download đó rồi đổi tên/di chuyển. Không bật lại fallback tải URL trực tiếp sau khi native download đã bắt đầu vì sẽ tạo 2–3 file trùng.

## 12. Production Queue

Nguồn:

- Engine: `main/production-queue.ts`.
- IPC: `main/production-queue-ipc.ts`.
- SQLite repositories: `main/project-database.ts`, `main/project-repositories.ts`.
- UI đầy đủ: `ProductionQueuePanel.tsx` và workflow scene components.

Bất biến:

- Queue chạy tuần tự để thao tác Flow không chồng lên nhau.
- Không dispatch job mới khi worker đang bận.
- Job tuân thủ `depends_on`.
- Continue chờ frame cuối scene trước.
- Retry dùng backoff hiện có; không tạo job trùng.
- Pause/stop phải đồng bộ UI, snapshot và worker.
- Sau restart, job `running` mồ côi được trả về `queued`; không tự lặp lại thao tác phá hủy.
- Xóa kết quả chỉ xóa asset/job liên quan; phải giữ Timeline, prompt, Visual Bible và character assignment.
- Xóa session phải xác nhận và bị chặn nếu còn active job.

Các component quản lý workflow hiện có:

- `WorkflowDashboard.tsx`
- `WorkflowHeader.tsx`
- `WorkflowControlBar.tsx`
- `WorkflowSceneList.tsx`
- `WorkflowSceneDetail.tsx`
- `WorkflowStatusBadge.tsx`
- `SceneDependencyTimeline.tsx`
- `scene-dependency-model.ts`
- `scene-dependency-types.ts`

## 13. Lưu trữ và đường dẫn

Trong production, `app.getPath("userData")` thường là:

```text
%APPDATA%/Vyren AI/
```

Dữ liệu chính:

```text
%APPDATA%/Vyren AI/
├─ timeline-session/session.json
├─ project-database/flowx.sqlite
├─ character-library/characters.json
├─ character-library/images/
├─ visual-style-library/
└─ dữ liệu CapCut/service liên quan
```

Timeline session store hiện version 4, có:

```text
activeSessionId
sessions[]
  ├─ id, name, createdAt, savedAt
  ├─ scenes[]
  ├─ visualBible
  ├─ styleReference
  ├─ workflowMode
  └─ workflowSource
```

Business data và output hiện dùng storage layout tập trung. Trên Windows có ổ D, mặc định là:

```text
D:/Vyren AI/
├─ Data/       session, SQLite, nhân vật, Visual Bible
├─ Outputs/    audio, SRT, ảnh, video, frame, metadata
└─ Backups/    bản sao an toàn CapCut
```

App tự migration dữ liệu business từ `%APPDATA%/Vyren AI` và output từ `Downloads/Vyren AI`, rebase đường dẫn JSON/SQLite, xác minh file đích rồi mới dọn thư mục business cũ. Cache Electron và localStorage UI vẫn ở AppData. Có thể ghi đè root bằng `VYREN_AI_STORAGE_ROOT`.

Output mỗi session:

```text
D:/Vyren AI/Outputs/session-<workspace-id>/
```

Trong app/output metadata có các nhóm logic: audio, srt, images, videos, final frames, prompts, visual-bible, logs và metadata. Không đổi đường dẫn hoặc trộn asset giữa session. Hàm chuẩn hóa folder nằm ở `shared/scene-job.ts::projectOutputFolder()`.

Nếu dùng biến môi trường test/dev:

- `FLOWX_DATA_DIR`: đổi root dữ liệu local.
- `FLOWX_WORKER_PORT`: đổi port WorkerServer.

## 14. CapCut

- Shared types: `shared/capcut.ts`.
- Service: `main/capcut-service.ts`.
- IPC: `main/capcut-ipc.ts`.
- UI: `renderer/CapCutBuildDialog.tsx`.

Nút dựng chỉ được bật khi:

- 100% scene cần thiết có video hợp lệ;
- không còn scene blocked;
- queue không còn chạy;
- kiểm tra output xác nhận đủ file video;
- backend/IPC CapCut sẵn sàng.

Không báo 100% chỉ dựa trên trạng thái UI nếu file thật đã mất.

## 15. Điều hướng và persistence UI

Thứ tự menu mong muốn:

```text
Trang chủ
Phiên làm việc
Voice Studio
Nhân vật
Visual Bible
Timeline & Prompt
Production Queue
Xuất dữ liệu
Cài đặt
```

Renderer đang lưu một số preference trong localStorage:

- page hiện tại;
- trạng thái thu gọn sidebar;
- queue drawer;
- selected scene theo session;
- Home mode và trạng thái đã review nhân vật;
- vị trí/trạng thái mở rộng của Progress Dock.

Khi đổi session phải reload dữ liệu và media theo session mới. Không để thumbnail/queue/session cũ rò sang phiên mới.

## 16. Các giới hạn hiện tại cần biết

- Queue snapshot chưa cung cấp đầy đủ phần trăm render live, startedAt/elapsed time cho mọi job.
- Worker status chưa tách đầy đủ extension version và last heartbeat cho toàn bộ UI; dữ liệu hiện có chủ yếu là connected state/profile/connectedAt.
- Điều hướng stage từ Homepage sang Queue chưa truyền bộ lọc sâu bằng query param ở mọi nơi.
- Homepage mode chi tiết và “characters reviewed” vẫn nằm trong localStorage, chưa nằm hoàn toàn trong session store.
- README chứa lịch sử nhiều phase; một số mô tả phase cũ có thể không phản ánh implementation mới nhất. Kiểm tra source/test trước khi sửa.
- Không có script `lint` trong `desktop-app/package.json`; không báo “lint pass” nếu chưa bổ sung linter thật.

## 17. Chẩn đoán lỗi thường gặp

### `ERR_CONNECTION_REFUSED ws://127.0.0.1:17890`

- Desktop app chưa chạy hoặc startup local service thất bại.
- Kiểm tra app chỉ có một instance, port 17890 không bị process khác giữ.
- Chạy app trước, sau đó reload extension/tab.

### `chat-worker disconnected while processing the job`

- Tab ChatGPT/profile bị đóng, extension vừa reload, service worker ngủ hoặc app bị restart.
- Mở ChatGPT đã đăng nhập, xác nhận extension badge ON, giữ tab khả dụng rồi retry đúng job.

### `Worker is already processing another job`

- Worker còn active job cũ hoặc queue/UI chưa nhận terminal event.
- Dừng queue/worker bằng handler hiện có, đợi snapshot không còn `activeJobId`, sau đó mới dispatch.
- Không chữa bằng cách tạo thêm job song song.

### Flow không tìm thấy mode/Frames/16:9/duration

- Google đã đổi DOM hoặc popup chưa ổn định.
- Inspect DOM thực tế, ưu tiên semantic selector; không sao chép Radix ID động nguyên vẹn.
- Thêm checkpoint: mở popup → chờ visible → click → xác nhận selected state → mới sang bước sau.

### Nhân vật bị upload lặp

- Kiểm tra detection thumbnail/ingredient và marker `cancel`.
- Khi marker thành công đã xuất hiện, phải dừng upload và chuyển sang dán/gửi prompt.

### Video render xong nhưng tải chậm hoặc tải trùng

- Chỉ theo dõi card của job mới bằng nội dung prompt/job identity, không click card cũ.
- Chỉ dùng native download một lần và chờ Chrome xác nhận cùng download item.
- Không đồng thời dùng DOM click và direct URL/blob fallback.

### `EBUSY: resource busy or locked`

- Chrome, Flow, media preview hoặc FFmpeg đang giữ file.
- Dùng filename duy nhất theo session/job, đóng preview, retry có giới hạn.
- Không unlink cưỡng bức file đang dùng và không xóa nhầm output của session khác.

## 18. Quy tắc an toàn khi AI khác sửa code

1. Chạy `git status` trước khi sửa. Worktree có thể đang chứa thay đổi chưa commit của người dùng; không reset/checkout/xóa chúng.
2. Chỉ sửa đúng phạm vi yêu cầu. Không rewrite backend/IPC/queue nếu yêu cầu chỉ là UI.
3. Không đổi tên API/channel/model nếu không cập nhật toàn bộ producer, consumer và test.
4. Không thêm mock data vào production để làm UI “trông hoạt động”.
5. Không tạo button giả; nếu chưa có backend, disable và ghi TODO rõ ràng.
6. Không tự duyệt ảnh khi toggle tắt.
7. Không xóa timeline/prompt khi người dùng chỉ yêu cầu xóa kết quả media.
8. Không phá dependency `start → continue`.
9. Không cho nhiều Flow job chạy đồng thời.
10. Mọi thao tác xóa/dừng/tạo lại có ảnh hưởng asset phải có xác nhận phù hợp.
11. Không lưu khóa, cookie, tài khoản Google/ChatGPT hoặc credential vào repo/log.
12. Khi thay selector Flow, thêm fallback semantic và test selector; tránh class hash và Radix ID động.

## 19. Lệnh chạy và kiểm tra

Từ PowerShell:

```powershell
cd "C:\Users\my pc\flow-continuity-studio\desktop-app"
npm install
npm run dev
```

Kiểm tra bắt buộc trước khi bàn giao:

```powershell
npm run typecheck
npm test
npm run build
```

Đóng gói Windows:

```powershell
npm run dist:win
```

Tạo bundle phân phối gồm installer/resource theo script dự án:

```powershell
npm run dist:bundle
```

Các smoke test đang có:

```powershell
npm run smoke:workers
npm run smoke:reconnect
npm run smoke:characters
npm run smoke:timeline
npm run smoke:scenes
npm run smoke:phase5
```

Installer mặc định:

```text
desktop-app/release/Vyren-AI-Setup-0.1.1.exe
```

Sau khi sửa extension:

1. Mở `chrome://extensions`.
2. Reload Vyren AI Worker ở từng Chrome profile.
3. Refresh tab ChatGPT/Google Flow.
4. Chạy desktop app và xác nhận đủ `chat-worker` + `flow-worker`.

## 20. Git và trạng thái bàn giao

- Remote: `https://github.com/trungchua1ny-rgb/KCAutoTool.git`.
- Branch quan sát khi tạo note: `main`.
- Commit nền gần nhất khi tạo note: `b617629 Package Vyren AI for Windows distribution`.
- Tại thời điểm tạo note, worktree đang có nhiều thay đổi UI/Homepage/CapCut/Timeline chưa commit. **Không được reset hoặc ghi đè hàng loạt**; phải xem `git diff` trước khi chỉnh.

## 21. Checklist đọc nhanh trước một task mới

1. Đọc yêu cầu mới nhất của người dùng; các yêu cầu cũ chỉ là bối cảnh.
2. Chạy `git status --short` và xem diff đúng file sắp sửa.
3. Đọc shared type + handler/service + component liên quan.
4. Xác nhận session hiện tại, queue state và extension version nếu lỗi liên quan runtime.
5. Giữ các bất biến về style, chain, continue frame, queue tuần tự và xóa an toàn.
6. Sửa nhỏ theo kiến trúc sẵn có, không dựng project song song.
7. Chạy typecheck, test và production build.
8. Báo rõ file sửa, logic tái sử dụng, kiểm tra đã chạy và giới hạn còn lại.

---

Nếu cần hiểu một hành vi cụ thể, bắt đầu từ model trong `desktop-app/src/shared`, lần theo IPC trong `desktop-app/src/preload` và `desktop-app/src/main`, sau đó mới đọc component renderer hoặc content script extension. Cách này tránh sửa UI dựa trên giả định sai về dữ liệu thật.
