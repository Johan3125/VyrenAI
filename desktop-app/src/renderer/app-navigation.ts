export type AppPage =
  | "home"
  | "sessions"
  | "voice"
  | "visual-bible"
  | "characters"
  | "timeline"
  | "edit"
  | "queue"
  | "output"
  | "settings";

export const PAGE_COPY: Record<AppPage, { title: string; description: string }> = {
  home: { title: "Trang chủ", description: "Theo dõi toàn bộ dây chuyền sản xuất video AI." },
  sessions: { title: "Phiên làm việc", description: "Mở, đổi tên và quản lý dữ liệu từng dự án." },
  voice: { title: "Voice Studio", description: "Tạo voice bằng Edge TTS hoặc dùng trực tiếp MP3 và SRT có sẵn." },
  "visual-bible": { title: "Visual Bible", description: "Khóa phong cách, màu sắc, ánh sáng và tính liên tục." },
  characters: { title: "Nhân vật", description: "Quản lý ảnh tham chiếu và nametag nhân vật." },
  timeline: { title: "Kịch bản cảnh", description: "Quản lý nội dung từng cảnh và câu lệnh tạo ảnh, video." },
  edit: { title: "Dựng CapCut", description: "Xếp toàn bộ video scene vào project CapCut với voice project hoặc audio gốc clip." },
  queue: { title: "Sản xuất", description: "Theo dõi công việc tạo ảnh và video đang chạy hoặc chờ xử lý." },
  output: { title: "Kết quả", description: "Kiểm tra audio, phụ đề, ảnh và video đã tạo." },
  settings: { title: "Cài đặt", description: "Kiểm tra kết nối worker và trạng thái hệ thống." },
};
