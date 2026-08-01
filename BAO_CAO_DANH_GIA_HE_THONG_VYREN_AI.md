# BÁO CÁO ĐÁNH GIÁ TOÀN DIỆN HỆ THỐNG VYREN AI

Ngày đánh giá: 25/07/2026  
Phạm vi: Desktop app Electron, React renderer, Chrome Extension Worker, giao thức WebSocket cục bộ, lưu trữ, Voice/TTS, Timeline/Prompt, Production Queue, adapter Google Flow/ChatGPT/Gemini/Grok, xuất dữ liệu, FFmpeg và CapCut.

---

## 1. Kết luận điều hành

Vyren AI đã vượt qua mức “bản demo giao diện”. Hệ thống có một lõi nghiệp vụ thật, tương đối sâu và có nhiều cơ chế tốt cho sản xuất video AI: quản lý phiên, Voice/SRT, Visual Bible, thư viện nhân vật, chia timeline 4/6/8 giây, chuỗi `single/start/continue`, hàng đợi bền vững bằng SQLite, retry, heartbeat, phục hồi sau crash, trích frame cuối, kiểm duyệt kết quả và xuất sang CapCut/FFmpeg.

Tuy nhiên, sản phẩm hiện phù hợp nhất với mức:

> **Beta nội bộ có người giám sát — đủ để sản xuất thử và dùng trong quy trình cá nhân/nhóm nhỏ, nhưng chưa nên quảng bá là hệ thống tự động hóa thương mại “chạy không cần giám sát”.**

Đánh giá tổng thể theo mã nguồn và kiểm thử hiện có: **6,5/10**.

Điểm mạnh nhất nằm ở lõi điều phối, mô hình continuity và khả năng phục hồi. Điểm yếu lớn nhất nằm ở lớp tự động hóa web, đặc biệt là Gemini/Grok; bảo mật kênh WebSocket; quản trị đường dẫn/media; an toàn khi di chuyển dữ liệu; tính trung thực của một số trạng thái UI; và thiếu lớp vận hành như log, chẩn đoán, cập nhật, backup, quyền riêng tư.

### Nhận định riêng về Gemini/Grok

Phần routing từ desktop tới `gemini-worker` và `grok-worker` đã được xây dựng thật, có capability, provider setting, queue routing và test giao thức. Tuy nhiên adapter media của Gemini/Grok hiện vẫn là adapter DOM tổng quát:

- tìm nút bằng nhãn chung như `image`, `video`, `create video`;
- tìm ảnh/video mới bằng cách so sánh tập phần tử DOM trước và sau khi gửi;
- tìm nút tải xuống bằng nhãn `download`, `save video`, `export`;
- chưa khóa và xác nhận rõ model, tỷ lệ, thời lượng, trạng thái attachment theo từng provider;
- chưa có bộ test DOM chuyên biệt tương đương Flow;
- chưa có bằng chứng từ test tự động chạy thật trên tài khoản Gemini/Grok đang đăng nhập.

Vì vậy, **không nên coi Gemini/Grok hiện đã ngang độ chín của Google Flow**. Chúng nên được gắn nhãn `Experimental/Beta`, đặt sau feature flag và chỉ chuyển sang `Stable` sau khi đạt ma trận kiểm thử live.

---

## 2. Phương pháp và giới hạn đánh giá

Báo cáo này dựa trên:

- đọc toàn bộ cấu trúc repository và các module chính;
- đối chiếu luồng renderer → preload → Electron main → WebSocket → extension → trang provider;
- đọc schema SQLite, LowDB store, migration, queue, adapter DOM và dịch vụ media;
- kiểm tra các đường dẫn xóa/sao chép/di chuyển dữ liệu;
- chạy bộ test hiện tại;
- chạy typecheck và production build;
- kiểm tra mức độ liên kết thật của các màn hình và các module chưa được dùng.

Kết quả xác minh:

- **89/89 test đạt**;
- **TypeScript typecheck đạt**;
- **Production build đạt**;
- bundle renderer hiện khoảng **1.217 MB JavaScript**, **309 KB CSS**, logo khoảng **907 KB**;
- chưa thực hiện phiên test live có đăng nhập trên các website bên ngoài trong audit này.

Do đó, các kết luận về độ bền của DOM adapter đối với giao diện provider hiện tại là đánh giá kỹ thuật từ mã nguồn và test fixture, không phải chứng nhận chạy live.

---

## 3. Kiến trúc hiện tại

```text
Người dùng
   │
   ▼
React Renderer
   │  typed IPC qua preload
   ▼
Electron Main
   ├─ Session/Character/Style/Provider stores (LowDB JSON)
   ├─ Project + Scene + Job repositories (SQLite WAL)
   ├─ Production Queue + retry + watchdog
   ├─ Voice Service (Edge TTS + FFmpeg/FFprobe)
   ├─ Output/Media/CapCut/Video Assembly services
   └─ WebSocket Server 127.0.0.1:17890
             │
             ▼
Chrome Extension Service Worker
   ├─ role/profile detection
   ├─ job lifecycle + downloads + Chrome Debugger
   └─ content adapters
        ├─ Google Flow
        ├─ ChatGPT
        ├─ Claude
        ├─ Gemini
        └─ Grok
             │
             ▼
Website AI đã đăng nhập trong Chrome
```

### 3.1 Phân lớp

Kiến trúc đã có sự phân lớp hợp lý:

- `desktop-app/src/renderer`: UI và state trình bày;
- `desktop-app/src/preload`: bridge IPC có kiểu dữ liệu;
- `desktop-app/src/main`: dịch vụ hệ thống, lưu trữ, hàng đợi và WebSocket;
- `desktop-app/src/shared`: contract và normalize/validate dùng chung;
- `extension-worker`: service worker, content scripts và browser automation.

Electron window đã bật `contextIsolation`, tắt `nodeIntegration` và bật sandbox. Renderer cũng có Content Security Policy. Đây là nền tảng bảo mật tốt.

### 3.2 Hai nguồn dữ liệu nghiệp vụ

Hệ thống đang dùng song song:

- LowDB `session.json`, schema phiên bản 4, làm nguồn dữ liệu cho Timeline/UI;
- SQLite schema phiên bản 3, làm nguồn dữ liệu cho Production Queue, scene và job.

Hệ thống đã có sync và reconciliation để giảm mất dữ liệu. Tuy nhiên đây vẫn là hai nguồn sự thật có thể lệch nhau. Việc phải duy trì `production-session-sync`, legacy migration và recovery cho thấy chi phí phức tạp đã bắt đầu lớn.

### 3.3 Mô hình worker

Mỗi Chrome profile tự nhận một role dựa trên các tab provider đang mở:

- `chat-worker`;
- `claude-worker`;
- `gemini-worker`;
- `grok-worker`;
- `flow-worker`.

Desktop chỉ giữ một kết nối hoạt động cho mỗi role. Cách này đơn giản và tránh chạy đúp, nhưng hạn chế throughput và gây nhập nhằng nếu một profile mở nhiều provider.

---

## 4. Đánh giá từng nhóm chức năng

Các mức được dùng trong bảng:

- **Ổn định nội bộ**: có thể dùng thật với quy trình hiện tại;
- **Beta**: dùng được nhưng cần người giám sát và còn rủi ro tương thích;
- **Experimental**: có contract/routing nhưng chưa đủ bằng chứng để hứa độ tin cậy;
- **Chưa triển khai**: UI hoặc type đã dự phòng nhưng không có adapter hoàn chỉnh.

| Nhóm chức năng | Mức hiện tại | Đánh giá thực tế |
|---|---:|---|
| Quản lý nhiều phiên | Ổn định nội bộ | Có tạo/chọn/đổi tên/xóa, khôi phục và cô lập project ID. Chưa có lifecycle media rõ khi xóa phiên. |
| Voice bằng Edge TTS | Beta | Có chia chunk, retry, pause theo dấu câu, SRT theo word timing, FFmpeg. Phụ thuộc endpoint không chính thức và mạng. |
| Nhập MP3 + SRT | Ổn định nội bộ | Kiểm tra stream MP3 bằng FFprobe, giới hạn kích thước/thời lượng, copy vào workspace, tự tìm sidecar SRT, cảnh báo timing. Đây là thiết kế phù hợp thực tế. |
| Speech-to-Text | Chưa triển khai | Các lựa chọn Gemini/Grok/API/local chỉ tồn tại dưới dạng option bị vô hiệu hóa. |
| Thư viện nhân vật | Ổn định nội bộ | Validate magic bytes, lưu ảnh managed, token hóa, tối đa 4 reference/scene. Cần tách rõ thư viện toàn cục và asset được link vào từng project. |
| Visual Bible | Beta | Có style/palette/lighting/continuity, preset và ảnh mẫu. Ảnh mẫu đang có thể nằm dạng data URL trong JSON phiên, làm file phiên phình lớn. |
| Phân tích SRT/kịch bản | Beta | Có validation coverage, scene 4/6/8 giây, batch, retry và schema normalization. Đầu ra vẫn phụ thuộc DOM/chat history của provider. |
| Beat & Chain Planning | Ổn định nội bộ | Mô hình `single/start/continue`, giới hạn chain và continuity contract là một trong các phần mạnh nhất. |
| Google Flow image/video | Beta | Có nhiều checkpoint, selector heuristic, native download, chống trùng và test DOM fixture khá sâu. Vẫn phụ thuộc giao diện web và cần giám sát. |
| ChatGPT Image | Beta | Có attachment, prompt, baseline và download. Độ sâu adapter thấp hơn Flow. |
| Gemini image/video | Experimental | Routing thật nhưng DOM adapter còn tổng quát; chưa khóa đầy đủ mode/model/duration/aspect và chưa có live gate. |
| Grok image/video | Experimental | Có điều hướng Grok Imagine và routing thật, nhưng nhận diện media/download vẫn heuristic chung. |
| Production Queue | Ổn định nội bộ | SQLite WAL, dependency, retry, watchdog, heartbeat, crash recovery, pause/resume/stop và regeneration chain. Đây là lõi tốt nhất của hệ thống. |
| Policy repair | Beta | Có phân loại và viết lại prompt an toàn. Taxonomy vẫn mang tên Flow dù đã chạy đa provider. |
| Output Library/metadata export | Beta | Có kiểm tra file, nhóm output và xuất JSON/CSV/Markdown/SRT. Chưa có checksum/catalog/log thật. |
| Ghép MP4 bằng FFmpeg | Beta kỹ thuật | Service và test đã tồn tại, có validate/encode/cancel; nhưng màn hình `EditPage` không được nối vào route thật. |
| Dựng CapCut | Experimental/Beta | Có backup project và thay video track. Phụ thuộc cấu trúc JSON nội bộ của CapCut, cần compatibility matrix và restore UI. |
| Logs/Help/Telemetry | Chưa triển khai | Menu Logs và Hướng dẫn đang bị disable; “Xem log” chỉ hiển thị vài trạng thái tổng hợp. |
| Installer/update | Beta sớm | Có NSIS installer và đóng gói extension. Chưa thấy cấu hình auto-update, code signing, release channel hoặc rollback. |

---

## 5. Điểm mạnh

### 5.1 Lõi điều phối có chiều sâu

Production Queue không chỉ là danh sách trong bộ nhớ. Hệ thống có:

- SQLite `STRICT` tables;
- foreign key và WAL;
- transaction `BEGIN IMMEDIATE`;
- trạng thái job/scene tách riêng;
- dependency giữa job;
- retry có backoff;
- heartbeat và watchdog;
- phục hồi job `running` sau khi app khởi động lại;
- stop/pause/resume;
- chạy lại một scene và làm mất hiệu lực chuỗi continuation liên quan.

Đây là nền tảng phù hợp cho tool sản xuất thật.

### 5.2 Continuity được thiết kế thành contract, không chỉ prompt

Việc dùng:

- scene duration 4/6/8 giây;
- `chainId`;
- `single/start/continue`;
- frame cuối của video trước làm frame đầu video sau;
- khóa source image và invalidation theo chain;

giúp giảm drift và tạo ra lợi thế chuyên môn rõ ràng so với tool chỉ gửi prompt độc lập.

### 5.3 Validation đầu vào tốt

Nhiều loại đầu vào được kiểm tra thực:

- character image kiểm tra magic bytes;
- MP3 được FFprobe xác nhận codec;
- SRT kiểm tra timestamp, trùng cue, độ lệch audio;
- timeline kiểm tra coverage, gap, overlap và duration;
- result được đối chiếu scene/media type;
- đường dẫn xóa production có nhiều lớp bảo vệ.

### 5.4 Phục hồi và migration đã được quan tâm

Hệ thống có:

- legacy project migration;
- session recovery từ SQLite;
- reconciliation giữa session và production project;
- rebase đường dẫn khi chuyển storage;
- bảo vệ stale renderer không xóa timeline đã có.

Đây là tư duy đúng cho desktop app có dữ liệu dài hạn.

### 5.5 Electron được cấu hình tương đối an toàn

Các lựa chọn `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` và CSP là tốt. Custom media protocol cũng có kiểm tra media nằm trong output root khi stream.

### 5.6 Chất lượng kiểm thử lõi tốt hơn mức prototype

89 test bao phủ:

- queue;
- DB/migration/storage;
- timeline/continuity;
- worker protocol;
- voice/MP3/SRT;
- FFmpeg assembly;
- Flow selector fixture;
- provider routing;
- homepage state model.

Test hiện tại tạo độ tin cậy tốt cho logic thuần và dịch vụ nội bộ.

---

## 6. Điểm yếu và rủi ro

## 6.1 Rủi ro P0 — cần xử lý trước khi phát hành cho người dùng bên ngoài

### P0.1 WebSocket localhost chưa có ghép cặp hoặc xác thực

Server chỉ yêu cầu message đầu tiên là `REGISTER`, sau đó xác nhận role/provider/capability. Không có:

- secret giữa app và extension;
- challenge-response;
- pairing code;
- kiểm tra `Origin`;
- protocol version độc lập;
- chữ ký/HMAC của job và result.

Bind vào `127.0.0.1` ngăn truy cập từ mạng LAN nhưng không chứng minh client là extension Vyren AI hợp lệ. Một client cục bộ có thể thử đăng ký role worker và nhận job chứa prompt hoặc ảnh base64.

Khuyến nghị:

1. App sinh `pairingSecret` ngẫu nhiên khi cài đặt.
2. Người dùng ghép extension bằng mã một lần hoặc native messaging.
3. Mỗi kết nối dùng nonce + HMAC.
4. Kiểm tra `Origin` khi có thể.
5. Thêm `protocolVersion`, `adapterVersion`, `selectorContractVersion`.
6. Mỗi job/result có nonce và workspace ID được xác minh.

### P0.2 Đường dẫn và media result chưa được khóa chặt

`normalizeSceneJobResult` mới kiểm tra scene ID, media type và chuỗi path không rỗng. `relocateSceneJobResult` trả nguyên result nếu path không nằm trong thư mục download được nhận diện. Ngoài ra IPC đọc preview ảnh có thể đọc một absolute image path mà chưa bắt buộc nằm trong output root.

Rủi ro:

- nhận nhầm file;
- hiển thị file ngoài workspace nếu renderer/worker bị sai hoặc bị chiếm;
- lưu một path không đúng định dạng vào DB;
- video downstream dùng file không hợp lệ.

Khuyến nghị:

- mọi result phải đi qua staging directory của app;
- chỉ chấp nhận path từ download ID do chính job đó tạo;
- kiểm tra absolute path, extension, magic bytes/FFprobe, kích thước, MIME, duration;
- tính SHA-256;
- di chuyển vào `Outputs/<project>/...` trước khi đánh dấu job thành công;
- từ chối mọi path ngoài allowlist;
- giới hạn IPC preview vào data root/output root/managed asset root.

### P0.3 Migration storage có nguy cơ dữ liệu

Migration hiện so sánh chủ yếu bằng kích thước và mtime, sau đó có thể xóa source cũ khi kết thúc. Kiểm tra cùng kích thước không chứng minh nội dung giống nhau.

Khuyến nghị:

- tạo manifest trước migration;
- kiểm tra SHA-256 cho mọi file quan trọng;
- SQLite dùng `PRAGMA integrity_check` và backup API;
- không xóa nguồn ngay; chuyển vào `Backups/Migration-Quarantine/<timestamp>`;
- chỉ dọn quarantine sau 7–30 ngày hoặc khi người dùng xác nhận;
- có màn hình “Khôi phục migration”;
- không merge im lặng hai workspace đang có dữ liệu khác nhau.

### P0.4 Trạng thái sản phẩm đang nói quá độ chín của một số tính năng

Các ví dụ:

- Gemini/Grok xuất hiện như provider chính thức nhưng adapter vẫn experimental;
- modal luôn ghi “0 tín dụng” cho mọi provider;
- queue dùng phần trăm cố định 8%/58% thay vì tiến độ thật;
- Worker panel có thể đánh dấu toàn bộ bước “done” chỉ vì có một job từng thành công;
- Voice Studio hiển thị “Đã lưu tự động” dù màn này chỉ lưu khi người dùng bấm lưu/tiếp tục;
- UI còn hiện nhãn nội bộ `Phase 5.1`, `Phase 6`.

Đây là vấn đề niềm tin sản phẩm. Trạng thái giả hoặc quá tự tin nguy hiểm hơn việc chỉ hiển thị “Đang xử lý”.

Khuyến nghị:

- Gemini/Grok gắn badge `Thử nghiệm`;
- thay “0 tín dụng” bằng “Chi phí phụ thuộc gói provider” hoặc bỏ hẳn;
- chỉ hiển thị progress indeterminate nếu không có dữ liệu thật;
- worker step phải lấy từ event log thực;
- implement autosave debounce hoặc đổi nhãn thành “Chưa lưu/Lưu bản nháp/Đã lưu lúc…”;
- bỏ toàn bộ số Phase khỏi UI người dùng.

### P0.5 Quyền riêng tư, điều khoản và license chưa đủ cho phát hành thương mại

Tool gửi nội dung thoại, SRT, kịch bản và ảnh tham chiếu tới các website AI đã đăng nhập. Hiện không thấy privacy notice/consent/retention policy trong repo.

Voice dùng `edge-tts-universal`, endpoint Microsoft Edge không chính thức, không có SLA và package lock ghi license AGPL-3.0. Trước khi phân phối thương mại cần đánh giá nghĩa vụ license và điều khoản sử dụng. Đây không phải kết luận pháp lý, nhưng là release blocker cần người có chuyên môn xác nhận.

Khuyến nghị:

- màn hình Data & Privacy nêu rõ loại dữ liệu gửi tới từng provider;
- consent trước lần chạy đầu tiên;
- không log prompt/ảnh nhạy cảm mặc định;
- chính sách retention và nút xóa dữ liệu;
- legal/license review cho Edge TTS, FFmpeg, extension automation và các provider;
- cân nhắc adapter TTS chính thức hoặc local TTS.

## 6.2 Rủi ro P1 — ảnh hưởng độ tin cậy và vận hành

### P1.1 Gemini/Grok chưa có adapter chuyên biệt

Adapter media đang dùng chung `content-chat.js`. Nó không có contract riêng đủ sâu cho:

- selector/version của Gemini;
- selector/version của Grok Imagine;
- model picker;
- duration picker;
- aspect ratio;
- trạng thái attachment;
- render card chính xác;
- job correlation;
- native download confirmation.

Việc phát hiện “phần tử ảnh/video mới” có thể nhận nhầm media khác trên trang. Download listener cũng có khả năng bắt nhầm download không thuộc job nếu người dùng thao tác song song.

Khuyến nghị kiến trúc:

```text
ProviderMediaAdapter
  detectSurface()
  verifyAccountReady()
  selectModel()
  selectMode()
  selectAspectRatio()
  selectDuration()
  attachReferences()
  verifyAttachments()
  submit(jobNonce)
  waitForResult(jobNonce)
  download(jobNonce)
  verifyDownloadedMedia()
  diagnoseFailure()
  cleanup()
```

Tách thành:

- `adapter-flow.js`;
- `adapter-gemini.js`;
- `adapter-grok.js`;
- `adapter-chatgpt-image.js`.

Không nên tiếp tục tăng điều kiện provider trong một file `content-chat.js`.

### P1.2 Adapter phụ thuộc active tab và làm gián đoạn thao tác người dùng

Extension chủ động focus cửa sổ và activate tab provider. Nếu người dùng sử dụng cùng profile trong lúc queue chạy, có thể:

- mất focus;
- thay đổi tab;
- làm baseline media sai;
- tải nhầm file;
- khiến job timeout.

Khuyến nghị:

- onboarding yêu cầu profile/window chuyên dụng;
- cho phép bind profileTag → provider cố định;
- hiển thị tên profile đã bind;
- khóa job khi tab URL/conversation/project thay đổi;
- cảnh báo rõ “không thao tác trong tab worker khi đang chạy”;
- dài hạn dùng Chrome side panel/native messaging hoặc API chính thức nếu có.

### P1.3 Hai nguồn sự thật làm tăng nguy cơ lệch state

LowDB và SQLite hiện đều giữ scene/source/media state. Recovery giúp giảm hậu quả nhưng không loại bỏ race.

Khuyến nghị:

- SQLite làm nguồn sự thật duy nhất cho project/session/scene/job/asset;
- renderer nhận snapshot/event từ main;
- JSON chỉ dùng export hoặc user preferences;
- thêm `revision`/optimistic concurrency;
- mọi save có transaction và event log.

### P1.4 Asset lifecycle chưa hoàn chỉnh

Các file Voice/MP3/SRT được đặt tên duy nhất, nhưng khi thay file hoặc xóa session, file cũ có thể còn lại. Style reference nằm trong JSON. Session delete không cho người dùng chọn giữ hay xóa output.

Khuyến nghị:

- bảng `assets`: ID, project ID, type, path, hash, size, source, refCount, createdAt;
- mọi scene/source chỉ tham chiếu asset ID;
- Replace tạo asset mới rồi hạ refCount asset cũ;
- “Xóa phiên” có ba lựa chọn: chỉ xóa project, chuyển media vào thùng rác, xóa vĩnh viễn;
- thùng rác giữ 7–30 ngày;
- cleanup report trước khi xóa.

### P1.5 Thiếu observability thực

Hiện chủ yếu dùng `console.*`. Output có nhóm `logs` nhưng không có logger ghi file. Menu Logs đang bị disable.

Khuyến nghị:

- structured log JSONL;
- correlation ID: session → scene → job → worker → download;
- vòng đời event không chứa nội dung nhạy cảm mặc định;
- log rotation;
- “Export diagnostic bundle” gồm version, capabilities, selector contract, job events, không gồm prompt/ảnh nếu chưa đồng ý;
- Error Center có actionable next step.

### P1.6 Cài đặt phụ thuộc còn thủ công

Người dùng phải:

- cài FFmpeg/FFprobe vào PATH;
- load unpacked extension;
- bật Developer Mode;
- mở/đăng nhập đúng tab và profile.

Đây là rào cản lớn với người dùng không kỹ thuật.

Khuyến nghị:

- bundle hoặc quản lý FFmpeg binary theo license phù hợp;
- phát hành extension đã ký qua Chrome Web Store/private channel;
- setup wizard kiểm tra từng dependency;
- one-click open đúng provider/profile;
- auto-update app và extension có compatibility gate;
- release channel stable/beta.

### P1.7 CapCut integration phụ thuộc schema nội bộ

Service sửa trực tiếp `draft_content.json` và clone cấu trúc từ một donor project. Backup toàn project là điểm tốt, nhưng vẫn cần:

- danh sách phiên bản CapCut đã kiểm chứng;
- kiểm tra schema signature;
- dry-run diff;
- nút restore backup;
- kiểm tra project sau khi CapCut mở lại;
- không chạy nếu version/schema chưa được chứng nhận.

Nên coi CapCut là “Advanced/Beta”. FFmpeg export nên là đường xuất mặc định an toàn hơn.

## 6.3 Rủi ro P2 — bảo trì, UX và hiệu năng

### P2.1 Nhiều file monolith

Các file lớn nhất:

- `style.css`: khoảng 3.877 dòng;
- `content-flow.js`: khoảng 2.696 dòng;
- `TimelineImport.tsx`: khoảng 2.632 dòng;
- `background.js`: khoảng 2.310 dòng;
- `production-queue.ts`: khoảng 1.954 dòng;
- `content-chat.js`: khoảng 1.911 dòng;
- `worker-server.ts`: khoảng 867 dòng.

`dark-fixes.css` thêm khoảng 764 dòng cho thấy CSS đang được vá theo lớp thay vì có design token/component boundary rõ.

Khuyến nghị:

- tách controller/hook/component theo bounded context;
- tách adapter provider;
- tách queue scheduler, asset operations, policy repair và snapshot projection;
- CSS modules hoặc component stylesheet;
- design tokens;
- lazy-load route lớn.

### P2.2 Bundle renderer lớn và không chia route

Bundle JavaScript hơn 1,2 MB, CSS hơn 300 KB và logo gần 1 MB. Với desktop đây chưa phải blocker, nhưng ảnh hưởng startup, memory và khả năng bảo trì.

Khuyến nghị:

- lazy import từng page;
- tối ưu logo WebP/PNG;
- loại dead code;
- tách Timeline/Editor/Settings chunk;
- đo startup thật thay vì che bằng splash dài.

### P2.3 Một số code/màn hình đã chết hoặc không nối vào sản phẩm

Các component không có consumer ngoài chính file:

- `HomeView.tsx`;
- `EditPage.tsx`;
- `ProjectJourney.tsx`;
- `SceneTimeline.tsx`;
- `SceneDetailDrawer.tsx`.

Route `edit` hiện mở `CapCutBuildPage`, trong khi native FFmpeg editor đã có service và test nhưng không có đường vào UI.

Khuyến nghị:

- quyết định rõ một trong hai:
  1. nối native editor/export vào sản phẩm và dùng nó làm đường xuất mặc định; hoặc
  2. xóa code UI/service không dùng khỏi production bundle.

### P2.4 Thuật ngữ và cấu trúc điều hướng quá nhiều

Sidebar có 10 page chính cộng Logs và Hướng dẫn bị disable. Tên trộn tiếng Việt/Anh:

- Voice Studio;
- Visual Bible;
- Timeline & Prompt;
- Production Queue;
- Worker;
- Output.

Khuyến nghị:

- workflow chính chỉ nên có 5 chặng: Nguồn → Nhân vật/Phong cách → Kịch bản cảnh → Sản xuất → Xuất;
- các page chi tiết nằm trong chặng, không đồng cấp toàn bộ;
- có glossary hoặc tooltip;
- Settings chỉ hiện worker/provider đang chọn, phần còn lại ở “Nâng cao”.

---

## 7. Phân tích sâu Google Flow so với Gemini/Grok

| Tiêu chí | Google Flow | Gemini/Grok hiện tại |
|---|---|---|
| Chọn mode | Có nhiều logic xác nhận mode | Chủ yếu tìm control theo nhãn |
| Duration | Có xác nhận tab 4s/6s/8s theo identity | Chủ yếu đưa duration vào prompt |
| Aspect ratio | Có xác nhận 16:9 ở Flow | Chủ yếu đưa 16:9 vào prompt |
| Attachment | Có nhiều checkpoint, thumbnail/cancel marker | Dựa trên attachment marker tổng quát |
| Prompt submit | Có type → read-back → stable → submit | Dùng composer chung |
| Result correlation | Có baseline/render-card heuristic sâu hơn | Tìm ảnh/video mới trong toàn DOM |
| Download | Flow có native download flow và chống trùng | Tìm download/share chung hoặc URL media |
| Error detection | Có viewer/render error logic riêng | Phân tích text assistant chung |
| Test DOM | Có fixture test sâu cho nhiều control | Chủ yếu test routing và helper/prompt |
| Mức khuyến nghị | Beta có giám sát | Experimental |

### Việc cần làm để Gemini/Grok “tương tự Google Flow” theo nghĩa chuyên nghiệp

Không chỉ cần “có adapter”. Cần đủ các lớp:

1. **Surface contract**: xác định đúng trang/mode/conversation.
2. **Preflight**: login, quota, model, ratio, duration, upload khả dụng.
3. **Attachment contract**: mỗi file có marker riêng và xác nhận ổn định.
4. **Submission contract**: prompt được đọc lại đầy đủ trước submit.
5. **Job correlation**: kết quả phải gắn được với job nonce/scene.
6. **Download contract**: đúng một download, đúng loại media, đúng thời điểm.
7. **Media validation**: ffprobe/magic/hash sau download.
8. **Cleanup contract**: đóng dialog/menu, trả tab về trạng thái sạch.
9. **Error taxonomy**: policy/quota/login/UI-change/timeout/download riêng.
10. **Canary test**: chạy tự động hằng ngày trên tài khoản test.

Chỉ khi cả 10 lớp đạt mới nên bỏ badge Experimental.

---

## 8. Những thứ nên giữ, lược bỏ và tinh chỉnh

## 8.1 Nên giữ và tiếp tục đầu tư

- SQLite Production Queue và crash recovery;
- Beat & Chain Planning;
- final-frame continuation;
- input validation;
- MP3 + sidecar SRT workflow;
- Visual Bible và explicit character assignment;
- manual approve/reject/regenerate;
- output isolation theo session;
- policy-repair có kiểm soát;
- custom media protocol;
- backup trước khi sửa CapCut.

## 8.2 Nên ẩn hoặc bỏ khỏi UI ngay

- lựa chọn STT bị disable cho đến khi có adapter;
- Logs/Hướng dẫn bị disable;
- `Phase 5.1`, `Phase 6` và tên phase nội bộ;
- “0 tín dụng” với provider không được xác minh;
- phần trăm queue giả 8%/58%;
- trạng thái worker step suy diễn không có event thật;
- “Đã lưu tự động” nếu chưa có autosave thật;
- splash 3,5 giây bắt buộc và phần giới thiệu vai trò cá nhân dài trong mỗi lần mở app;
- các provider chưa ổn định khỏi luồng mặc định; chuyển vào “Thử nghiệm”.

## 8.3 Nên lược bỏ khỏi code/repo sản phẩm

- component chết sau khi xác nhận không còn kế hoạch dùng;
- CSS patch cũ sau khi gom về design system;
- `vyren-ai-flow` tách khỏi nhánh/package sản phẩm chính; giữ riêng khỏi `extension-worker`;
- phase changelog dài trong README; chuyển sang `CHANGELOG.md`;
- tên legacy như `flowx`, `flowImageAssetKey`, `GoogleFlowWorkerPanel` ở lớp provider-neutral;
- error category `flow_*` trong core queue; đổi thành `provider_policy_violation`, `provider_generation_failed`, `provider_quota_or_rate_limit`.

## 8.4 Nên tinh chỉnh UX

### Voice/MP3

Thiết kế hiện tại “MP3 không cần chọn voice” là đúng. Nên giữ:

- mode tách biệt;
- bắt buộc SRT để có timeline chuẩn;
- tự tìm sidecar SRT;
- hiển thị duration/bitrate/sample rate/warning.

Nên bổ sung:

- waveform và điểm bắt đầu/kết thúc SRT;
- nút “Thay MP3” có cleanup asset cũ;
- tùy chọn “Tạo SRT bằng STT” khi adapter thật sẵn sàng;
- checksum và duplicate detection;
- trạng thái lưu thật;
- cảnh báo rõ file được sao chép vào project.

### Provider Center

Mỗi provider cần:

- badge Stable/Beta/Experimental;
- version extension;
- capability thực;
- tab/profile đã bind;
- login/preflight;
- lần test gần nhất;
- hạn mức/quota nếu đọc được;
- nút “Chạy kiểm tra adapter” không tốn generation khi có thể.

### Production Queue

Nên hiển thị:

- job phase thật;
- thời gian đã chạy;
- heartbeat gần nhất;
- provider/profile;
- attempt và lý do retry;
- dependency;
- ETA chỉ khi có dữ liệu đủ tin cậy;
- nút mở đúng tab/job.

Không nên hiển thị percent giả.

### Xóa dữ liệu

Mọi thao tác xóa cần:

- preview file sẽ xóa;
- dung lượng;
- phạm vi local/provider;
- thùng rác có thể khôi phục;
- lựa chọn giữ media khi xóa session.

---

## 9. Kiến trúc đích đề xuất

```text
Renderer
  └─ ViewModel/Event subscription
       └─ Application Services
            ├─ ProjectService
            ├─ AssetService
            ├─ VoiceService
            ├─ TimelineService
            ├─ ProductionScheduler
            ├─ ExportService
            └─ DiagnosticService
                 │
                 ├─ SQLite: nguồn sự thật duy nhất
                 ├─ Managed Asset Store + hashes
                 └─ Secure Worker Gateway
                       ├─ pairing + protocol version
                       ├─ role/profile binding
                       └─ Provider Adapter Registry
                            ├─ FlowAdapter
                            ├─ GeminiAdapter
                            ├─ GrokAdapter
                            └─ ChatGPTAdapter
```

### Các nguyên tắc

1. Một nguồn sự thật.
2. Mọi media là managed asset.
3. Mọi job có correlation ID.
4. Mọi worker được xác thực.
5. Mọi provider có contract riêng.
6. UI chỉ hiển thị trạng thái có bằng chứng.
7. Tính năng chưa đủ gate phải được gắn Experimental.
8. Mọi thay đổi dữ liệu phá hủy phải có recovery path.

---

## 10. Roadmap ưu tiên

## Giai đoạn 0 — 1 đến 2 tuần: sửa tính trung thực và an toàn cơ bản

1. Gắn Experimental cho Gemini/Grok media.
2. Bỏ “0 tín dụng”, Phase labels và percent giả.
3. Sửa autosave label ở Voice Studio.
4. Ẩn STT/Logs/Hướng dẫn chưa triển khai.
5. Khóa `MEDIA_READ_IMAGE` vào managed roots.
6. Validate mọi worker result bằng path allowlist + magic/FFprobe.
7. Tạo backup SQLite/session trước migration.
8. Không xóa source migration ngay; đưa vào quarantine.
9. Thêm privacy notice tối thiểu.
10. Tạo `CHANGELOG.md`, `SECURITY.md`, `PRIVACY.md`, license inventory.

## Giai đoạn 1 — 3 đến 6 tuần: củng cố kiến trúc

1. Thêm secure pairing cho WebSocket.
2. Thêm protocol/adapter/selector versions.
3. Tách adapter Flow/Gemini/Grok/ChatGPT.
4. Bind profileTag cố định vào provider.
5. Provider-neutral error taxonomy.
6. Asset registry có hash/refCount.
7. Đưa style reference ra file managed.
8. Bắt đầu hợp nhất LowDB session vào SQLite.
9. Persistent structured logs và diagnostic bundle.

## Giai đoạn 2 — 7 đến 10 tuần: kiểm thử live và vận hành

1. DOM fixture riêng cho Gemini và Grok.
2. Live smoke account cho từng provider.
3. Canary test theo lịch.
4. Test download correlation và thao tác người dùng song song.
5. Test 30–50 scene/provider/configuration.
6. Test crash/restart ở mọi checkpoint.
7. Signed extension + update channel.
8. FFmpeg dependency manager.
9. Backup/restore UI.
10. CapCut version compatibility matrix và restore button.

## Giai đoạn 3 — 11 đến 14 tuần: hoàn thiện sản phẩm

1. Đơn giản hóa navigation.
2. Nối native MP4 export vào UI và dùng làm lựa chọn mặc định.
3. CapCut ở Advanced/Beta.
4. Loại dead code và chia bundle.
5. Accessibility và keyboard navigation.
6. Onboarding wizard.
7. Release checklist, rollback plan và support workflow.

---

## 11. Tiêu chí nghiệm thu đề xuất

### 11.1 Security

- client không có pairing secret không thể đăng ký worker;
- job cũ/replay bị từ chối;
- mọi preview/result path nằm trong managed roots;
- mọi media được xác minh định dạng trước khi ghi DB;
- diagnostic bundle không chứa prompt/ảnh theo mặc định.

### 11.2 Data safety

- migration test trên ma trận storage trống/có dữ liệu/xung đột;
- checksum 100% file nghiệp vụ;
- `PRAGMA integrity_check` đạt;
- nguồn cũ nằm trong quarantine và có thể restore;
- crash ở từng bước migration không làm mất cả source và destination.

### 11.3 Provider adapter

Mỗi adapter trước khi lên Stable cần:

- ít nhất 30 job image và 30 job video liên tiếp trên tài khoản test;
- 0 trường hợp lấy nhầm media;
- 0 download trùng;
- 100% output qua validation;
- nhận diện đúng login/quota/policy/UI changed;
- stop/cancel không để lại job “ma”;
- chạy lại sau reload tab và restart extension.

Mục tiêu vận hành đề xuất:

- first-attempt success ≥ 90% trong môi trường test kiểm soát;
- recovery/retry success ≥ 97%;
- sai media/download trùng = 0;
- lỗi DOM có selector diagnostic rõ trong 100% trường hợp.

### 11.4 Queue

- crash recovery không tạo job trùng;
- continuation luôn dùng đúng frame upstream mới nhất;
- regenerate upstream invalidates toàn bộ downstream cần thiết và không đụng scene ngoài chain;
- pause/stop có trạng thái cuối xác định;
- không có stale renderer save khôi phục media đã xóa.

### 11.5 UX

- không có progress/cost/status giả;
- người dùng mới hoàn tất setup trong một wizard duy nhất;
- mỗi lỗi có “nguyên nhân + việc cần làm + nút hành động”;
- provider experimental không thể bị hiểu là stable;
- xóa/migration đều có recovery path.

---

## 12. Bảng điểm

| Hạng mục | Điểm /10 | Nhận xét |
|---|---:|---|
| Kiến trúc tổng thể | 7,0 | Phân lớp tốt, nhưng hai nguồn dữ liệu và monolith bắt đầu gây nợ kỹ thuật. |
| Chiều sâu chức năng | 8,0 | Workflow end-to-end rộng và có nhiều chi tiết thực tế. |
| Production Queue/continuity | 8,5 | Phần trưởng thành nhất. |
| Voice/MP3/SRT | 7,5 | MP3 import tốt; TTS phụ thuộc dịch vụ không chính thức; chưa có STT. |
| Google Flow adapter | 6,5 | Nhiều checkpoint, nhưng vẫn là DOM automation. |
| Gemini/Grok adapter | 4,5 | Routing thật, adapter media chưa đủ chuyên biệt và chưa có live gate. |
| Bảo mật | 5,5 | Electron base tốt; WebSocket pairing và path validation còn thiếu. |
| An toàn dữ liệu | 6,0 | Recovery tốt; migration/xóa/asset lifecycle cần nâng cấp. |
| UX và tính trung thực | 6,0 | Giao diện đẹp và nhiều thông tin, nhưng có trạng thái giả, phase labels và menu chưa làm. |
| Khả năng bảo trì | 5,0 | Nhiều file lớn, logic provider ghép chung, dead code và CSS patch. |
| Kiểm thử | 7,5 | 89 test tốt cho core; thiếu UI E2E/live provider matrix. |
| Vận hành/phát hành | 4,5 | Thiếu persistent logs, updater, signing, privacy, backup UI và setup tự động. |

Điểm tổng hợp: **6,5/10**.

---

## 13. Quyết định sản phẩm đề xuất

### Có thể làm ngay

- tiếp tục dùng nội bộ;
- chạy workflow có người giám sát;
- dùng Flow làm adapter chính;
- dùng MP3 + SRT hoặc Edge TTS với cảnh báo rõ;
- tận dụng Queue/continuity và output isolation;
- thử Gemini/Grok trên project không quan trọng dưới badge Experimental.

### Chưa nên làm

- quảng bá Gemini/Grok là ngang Flow;
- chạy hàng trăm scene hoàn toàn không giám sát;
- phân phối thương mại mà chưa xử lý pairing, privacy/license và migration safety;
- hứa “0 credit”;
- dùng CapCut integration trên version chưa kiểm chứng mà không có restore;
- coi Logs/Help/STT là chức năng đã có.

### Release gate tối thiểu

Chỉ nên gọi là `Stable v1.0` khi hoàn tất:

1. secure worker pairing;
2. managed media validation;
3. backup/quarantine migration;
4. privacy/license review;
5. provider-specific Gemini/Grok adapters;
6. live adapter test matrix;
7. persistent logs;
8. signed installer/extension và update plan;
9. UI không còn trạng thái giả;
10. một nguồn dữ liệu nghiệp vụ hoặc cơ chế revision rõ ràng.

---

## 14. Bằng chứng kỹ thuật chính

- Electron hardening: `desktop-app/src/main/index.ts:94–115`.
- WebSocket chưa có secret: `desktop-app/src/main/worker-server.ts:175–247`.
- Payload tối đa 64 MB: `desktop-app/src/main/worker-server.ts:46`.
- Extension dùng quyền `tabs`, `scripting`, `debugger`: `extension-worker/manifest.json:7`.
- Gemini/Grok dùng media finder chung: `extension-worker/content-chat.js:1101–1345`.
- Storage chỉ kiểm tra size trước khi xóa source: `desktop-app/src/main/storage-manager.ts:140–166`, `345–355`.
- Preview ảnh chưa khóa root: `desktop-app/src/main/media-ipc.ts:34–43`.
- Result path validation còn mỏng: `desktop-app/src/shared/scene-job.ts:239–266`.
- Path ngoài managed download được trả nguyên: `desktop-app/src/main/media-relocation.ts:44–51`.
- LowDB session và SQLite project tồn tại song song: `desktop-app/src/main/timeline-session-store.ts:29–72`, `desktop-app/src/main/project-database.ts:5–171`.
- Queue sync session vào SQLite tại thời điểm chạy production: `desktop-app/src/main/production-queue.ts:1246`.
- Progress giả: `desktop-app/src/renderer/ProductionQueuePanel.tsx:129`.
- Worker step suy diễn: `desktop-app/src/renderer/WorkerPanels.tsx:146–161`.
- Autosave label ở Voice Studio: `desktop-app/src/renderer/VoiceWorkflow.tsx:497`.
- “0 tín dụng”: `desktop-app/src/renderer/ImageGenerationModal.tsx:97`, `VideoGenerationModal.tsx:63`.
- Menu chưa triển khai: `desktop-app/src/renderer/Sidebar.tsx:116–117`.
- Package TTS AGPL-3.0: `desktop-app/package-lock.json:3179–3184`.
- App version `0.1.1`, extension `2.58.0`: `desktop-app/package.json:4`, `extension-worker/manifest.json:4`.
- Build/test: 89/89 test đạt, typecheck đạt, production build đạt tại thời điểm audit.

---

## 15. Kết luận cuối

Vyren AI có giá trị kỹ thuật thật và có một lõi workflow đáng giữ. Dự án không cần viết lại từ đầu. Hướng đúng là:

1. giữ nguyên lõi queue/continuity;
2. củng cố security và asset safety;
3. tách adapter theo provider;
4. đưa Gemini/Grok về đúng trạng thái Experimental cho đến khi có live gate;
5. loại trạng thái giả và phần UI chưa làm;
6. hợp nhất dữ liệu, thêm log/backup/update;
7. dùng native FFmpeg export làm phương án an toàn, CapCut là tích hợp nâng cao.

Nếu thực hiện đúng roadmap trên, sản phẩm có thể chuyển từ beta nội bộ sang một công cụ sản xuất chuyên nghiệp mà không phải phá bỏ nền móng hiện tại.
