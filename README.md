# Louva — CRM Phòng khám Thẩm mỹ

Phần mềm được lập trình theo ba tài liệu mô tả trong repo:

| Tài liệu | Vai trò |
|---|---|
| `docs/schema_tmv.prisma` | Lược đồ dữ liệu mục tiêu (~140 model, PostgreSQL) |
| `docs/prototype_tmv.html` | Đặc tả màn hình, màu sắc, luồng thao tác |
| `wiki/Phong_Kham_Tham_My/Kien_Truc_CRM_Tham_My.md` | Kiến trúc, phân quyền, danh sách endpoint, lộ trình 3 giai đoạn |

Phạm vi đã hiện thực: **Giai đoạn 1 — MVP "mở cửa được phòng khám"** (mục 7 tài liệu kiến trúc).

---

## Chạy thử trong 2 phút

```bash
cd crm-app/backend && npm install && npx tsx prisma/seed.ts
```

```bash
cd crm-app/backend && npm run dev
```

```bash
cd crm-app/desktop && npm install && npm run dev
```

Đăng nhập bằng bất kỳ tài khoản nào dưới đây, mật khẩu chung `123456`:

| Vai trò | Email | Thấy được gì |
|---|---|---|
| Giám đốc / Chủ đầu tư | `giamdoc@louva.vn` | Toàn bộ số liệu phòng khám |
| Quản lý cơ sở | `quanly@louva.vn` | Điều hành cơ sở |
| Lễ tân | `letan@louva.vn` | Lịch hẹn, check-in, thu tiền — **không có bệnh án** |
| Tư vấn viên | `thuha@louva.vn` | Khách của mình, báo giá, hợp đồng |
| Telesale | `minhngoc@louva.vn` | Chỉ khách mình phụ trách |
| Bác sĩ | `bs.tuan@louva.vn` | Bệnh án, ảnh, lịch mổ trong cơ sở |
| Điều dưỡng | `dd.nhung@louva.vn` | Chăm sóc, sinh hiệu, ảnh |
| Kế toán | `ketoan@louva.vn` | Hợp đồng, công nợ, báo cáo tài chính |
| Marketing | `marketing@louva.vn` | **Số điện thoại khách bị che `09xx xxx 123`** |

Tài khoản quản trị hệ thống: `admin@louva.vn` / `admin123`.

Tên nhân viên, khách hàng và số liệu ở trên đều là **dữ liệu mẫu** dựng theo
prototype để anh xem giao diện — thay bằng nhân sự thật ở màn *Người dùng &
Phân quyền*.

### Tạo tài khoản quản trị

Thêm nhân viên thường thì làm trên giao diện (*Người dùng & Phân quyền*). Script
dưới đây dành cho tài khoản quản trị cấp cao và cho tình huống **không ai đăng
nhập được** (mất mật khẩu quản trị, dựng máy chủ mới):

```bash
cd crm-app/backend && npx tsx scripts/create-admin.ts --email ceo@louva.vn --name "Xuân Trường"
```

Mặc định gán hai vai trò `GIAM_DOC` + `QUAN_LY_HE_THONG`, gán vào mọi cơ sở, sinh
mật khẩu ngẫu nhiên 20 ký tự và in ra một lần duy nhất. Tài khoản luôn bị đánh
dấu **bắt buộc đổi mật khẩu** ở lần đăng nhập đầu.

Chạy lại với cùng email sẽ **cập nhật** tài khoản đó (đặt lại mật khẩu + gán lại
vai trò) và thu hồi mọi phiên đang mở của họ. Thêm `--keep-password` nếu chỉ muốn
đổi vai trò mà giữ nguyên mật khẩu.

### Làm mới dữ liệu demo

Dữ liệu mẫu gắn với ngày chạy seed, nên sau vài ngày mở app lên sẽ thấy lịch hẹn
và lịch mổ trống — không phải lỗi, nhưng nhìn như hỏng khi trình diễn. Dời toàn
bộ mốc thời gian về hôm nay (giữ nguyên tài khoản người dùng):

```bash
cd crm-app/backend && npx tsx scripts/refresh-demo-dates.ts
```

Hàng đợi lễ tân luôn được xếp lại theo giờ chạy, kể cả khi không cần dời ngày.

### Đổi tên phòng khám

Tên hiển thị lấy từ cơ sở đầu tiên trong CSDL. Đổi trước lần chạy đầu bằng biến
môi trường, hoặc sửa trực tiếp ở màn Cài đặt sau đó:

```bash
CLINIC_NAME="Phòng khám Thẩm mỹ Louva" CLINIC_CODE=LOUVA npm run dev
```

Hệ thống vẫn giữ nguyên kiến trúc **đa cơ sở** (nền tảng của phân quyền và cách
ly bệnh án) — chỉ là khởi tạo sẵn một cơ sở. Mở thêm chi nhánh qua
`POST /api/org/branches`; ô chọn cơ sở trên thanh bên tự hiện khi có từ 2 cơ sở
trở lên.

Muốn thấy rõ mô hình phân quyền: đăng nhập lần lượt bằng *lễ tân* rồi *bác sĩ* và
mở cùng một hồ sơ khách — tab "Hồ sơ y khoa" chỉ hiện với bác sĩ.

### Chạy như web app (không cần Electron)

```bash
cd crm-app/desktop && npx vite --config vite.web.config.mts
```

Mở `http://localhost:5173`. Renderer tự rơi về `localStorage` khi không có
Electron (xem `src/renderer/src/lib/bridge.ts`) — đây là bước đệm sang kiến trúc
web app mà mục 2.1 tài liệu kiến trúc đã chốt.

---

## Truy cập từ xa qua Cloudflare Tunnel

```bash
cd crm-app && ./share-remote.sh
```

Script làm 4 việc: build giao diện web → chạy máy chủ → mở đường hầm Cloudflare →
kiểm tra từ ngoài, rồi in ra link `https://….trycloudflare.com`.

```bash
cd crm-app && ./share-remote.sh url
```

```bash
cd crm-app && ./share-remote.sh stop
```

**Cách hoạt động:** máy chủ Express phục vụ luôn bản web đã build
(`desktop/out/web`), nên giao diện và API nằm **cùng một origin** — chỉ cần một
đường hầm vào cổng 4000, không vướng CORS, WebSocket bám đúng tên miền và tự lên
`wss://`. Bản web dùng đường dẫn API tương đối `/api` nên **cùng một bản build
chạy được ở mọi tên miền** mà không phải build lại.

### Bốn giới hạn phải biết trước khi gửi link cho người khác

1. **Link công khai, không có lớp chặn nào phía trước.** Ai có link đều mở được
   trang đăng nhập. Đổi toàn bộ mật khẩu mặc định (`admin123`, `123456`) trước
   khi gửi ra ngoài.
2. **Link đổi mỗi lần khởi động lại.** Quick tunnel không cần tài khoản
   Cloudflare, đánh đổi là tên miền ngẫu nhiên. Muốn link cố định: đăng nhập
   `cloudflared tunnel login`, tạo named tunnel gắn vào tên miền của mình, và
   bật **Cloudflare Access** để chặn ngay ở biên trước khi chạm tới máy chủ.
3. **Sống theo máy này.** Máy tắt, ngủ, hoặc mất mạng là link chết. Script đã tự
   bật `caffeinate` giữ máy thức chừng nào tunnel còn chạy.
4. **Chưa phải hạ tầng chạy thật.** Đây là cách chia sẻ để xem/nghiệm thu. Khi
   vận hành thật với dữ liệu bệnh nhân, phải theo mục 3.1 tài liệu kiến trúc:
   máy chủ riêng, PostgreSQL có PITR, backup off-site, TLS + rate-limit ở biên.

---

## Đã làm những gì

### Bảo mật và tuân thủ (mục 3, 4, 6 tài liệu kiến trúc)

Đây là phần được làm trước tiên, đúng yêu cầu *"không đẩy hạng mục bảo mật + RBAC
+ audit xuống sau"*.

- **Phiên thu hồi được**: access token 15 phút + `AuthSession` refresh 7 ngày, xoay
  vòng mỗi lần làm mới, **phát hiện tái sử dụng token** thì thu hồi cả chuỗi phiên.
  Đổi quyền / khoá tài khoản là mất quyền **ngay**, không chờ token hết hạn.
- **RBAC ba cổng** (`src/middleware/rbac.ts`): vai trò → cơ sở → phạm vi dữ liệu
  (`ALL` / `BRANCH` / `OWN`). Cổng 2 và 3 trả **404 chứ không phải 403** để không
  lộ sự tồn tại của hồ sơ ở cơ sở khác.
- **Cách ly bệnh án theo cơ sở** (`src/lib/medical-scope.ts`): khách liên thông
  toàn công ty, bệnh án thì không. Xem chéo phải **break-glass** — nêu lý do, quyền
  cấp 30 phút, ghi log mức `CRITICAL`, **thông báo ngay cho Giám đốc chuyên môn**.
- **Hai sổ nhật ký tách bạch**: `AuditLog` ghi thay đổi, `DataAccessLog` ghi cả
  hành vi **chỉ đọc** bệnh án / ảnh / số điện thoại / mỗi lần xuất dữ liệu.
- **Ảnh trước-sau mã hoá AES-256-GCM khi lưu**. Ảnh không có URL tĩnh; mỗi lần xem
  đều qua API kiểm quyền và ghi log. Tải về cần quyền riêng `photo.download`.
- **Secret Zalo mã hoá**, không bao giờ trả ngược về máy khách.
- **Webhook Zalo**: xác thực HMAC trên **raw body**, xử lý **đúng một lần**
  (bảng `ZaloWebhookEvent`).
- **CORS chặt** theo danh sách origin, **socket.io có xác thực và phân room**
  (`branch:` / `conv:` / `user:`) thay vì phát cho mọi kết nối.
- **Che số điện thoại** với vai trò không có `customer.view_phone`.
- **Xuất dữ liệu có hạn mức** số dòng và luôn ghi nhật ký truy cập.

### Nghiệp vụ

| Phân hệ | Điểm đáng chú ý |
|---|---|
| Hộp thư Zalo | 3 cột đúng prototype, realtime, nhiều OA (mỗi cơ sở một OA), gán phụ trách, gắn hồ sơ khách. Gửi lỗi vẫn **lưu tin ở trạng thái FAILED** thay vì làm mất tin |
| Lễ tân · Lịch hẹn | Lưới bác sĩ × phòng, **chặn trùng lịch**, thời lượng lấy theo dịch vụ, huỷ hẹn bắt buộc lý do |
| Lễ tân · Khách đã đến | Hàng đợi realtime, cảnh báo chờ quá 20 phút, luồng `WAITING → … → DONE` **không cho lùi** |
| Khách hàng | Liên thông giữa các cơ sở, 8 tab, timeline gộp, **lùi giai đoạn phễu bắt buộc lý do**, không xoá được khách — chỉ ẩn kèm lý do |
| Lead & chiến dịch | CPL / ROAS, convert lead **gộp vào khách trùng SĐT** thay vì tạo bản mới |
| Hợp đồng & tiền | Báo giá → hợp đồng → hoá đơn từng đợt → phiếu thu; **chặn báo giá dưới giá sàn**; thu tiền cập nhật hoá đơn + hợp đồng trong **một transaction** |
| Bệnh án | Dị ứng, chống chỉ định, cam kết ký, ảnh theo mốc PRE_OP/D1/D7/M1/M3/M6 |
| Phòng mổ | **Checklist tiền phẫu chấm tự động từ dữ liệu thật** (đã cọc ≥30%? đã ký cam kết? đã chụp ảnh trước mổ?). Thiếu là **không xác nhận được ca**. Kết thúc mổ tự sinh lịch tái khám N1/N7/T1/T3 |
| Bảng giá | Giá theo **cơ sở** và theo **hiệu lực thời gian** — đặt giá mới không ghi đè giá cũ |
| Báo cáo | Dashboard chủ đầu tư, doanh thu, phễu marketing, hiệu suất nhân viên, vận hành phòng khám. Tất cả bằng truy vấn tổng hợp SQL |

---

## Hai quyết định kỹ thuật cần biết

### 1. SQLite thay vì PostgreSQL — và cách đổi lại

Tài liệu kiến trúc chốt PostgreSQL. Máy phát triển hiện tại **không có
PostgreSQL, không có Docker, không có Homebrew**, nên để phần mềm chạy được ngay,
schema đang chạy hạ xuống SQLite. Quy ước được giữ để việc đổi là cơ học:

| Trên SQLite | Khi lên PostgreSQL |
|---|---|
| Cột trạng thái là `String`, giá trị hợp lệ ở `src/types/enums.ts`, ép bằng zod | Thay bằng `enum` thật |
| Tiền là `Int`, **đơn vị đồng** (không dùng `Float` ở bất kỳ đâu) | `Decimal(14,2)` |
| Trường danh sách lưu JSON dạng chuỗi | `String[]` / `JSONB` |
| `bootstrap.ts` tự chạy `migrate deploy` khi khởi động | Chuyển migration vào CI |
| Kho tệp cục bộ đã mã hoá (`src/lib/storage.ts`) | Đổi thân hàm sang S3/R2, giữ nguyên chữ ký hàm |
| socket.io một tiến trình | Thêm Redis adapter đúng chỗ đã đánh dấu trong `src/socket/index.ts` |

Ước tính trong tài liệu là **~5–7 ngày công** cho việc chuyển stack; phần khó
(bảo mật, RBAC, audit, nghiệp vụ) đã xong.

### 2. Khoá mã hoá

Lần chạy đầu, hệ thống sinh khoá 32 byte tại `backend/data/.enc-key` nếu chưa đặt
biến môi trường `ENCRYPTION_KEY`.

> **Sao lưu tệp này cùng cơ sở dữ liệu. Mất khoá là mất toàn bộ ảnh trước-sau và
> token Zalo.** Lên production phải đưa khoá vào KMS/Vault, không để cạnh CSDL.

---

## Chưa làm (Giai đoạn 2 và 3)

Đúng danh sách "cắt khỏi MVP" của tài liệu: kho vật tư theo lô và truy vết
implant, thư viện case có ẩn danh hoá, trả góp và hoàn tiền, chấm công, hoa hồng
tự động, kế toán chi tiết, biến chứng/khiếu nại có SLA, KPI điều dưỡng.

Các mục này có sẵn trong menu, bấm vào hiện màn hình ghi rõ thuộc giai đoạn nào —
để người dùng không tưởng là lỗi.

**Ngoài ra chưa làm dù nằm trong Giai đoạn 1:** 2FA cho vai trò xem bệnh án, ZNS
nhắc lịch tự động (cần BullMQ + Redis), và script di trú dữ liệu từ `crm.db` cũ.
Bản CSDL và migration cũ đã được sao lưu tại `crm-app/_backup_legacy/`.

---

## Cấu trúc mã nguồn

```
backend/
  prisma/schema.prisma     ~50 model, chú thích rõ quy ước
  prisma/seed.ts           dữ liệu mẫu dựng lại đúng bối cảnh prototype
  src/lib/                 env · crypto · storage · session · audit · medical-scope · rbac-catalog
  src/middleware/          auth (xác thực) · rbac (ba cổng phân quyền)
  src/routes/              auth org users customers leads inbox zalo reception
                           catalog sales medical surgery reports audit
  src/socket/              socket.io có xác thực + room
desktop/
  src/renderer/src/
    styles/theme.css       hệ thiết kế port nguyên từ prototype
    lib/                   api (tự làm mới token) · auth-context · socket · ui · format · bridge
    components/            AppShell (menu lọc theo quyền) · ErrorBoundary · ui
    pages/                 18 màn hình
```

## Kiểm tra chất lượng

```bash
cd crm-app/backend && npx tsc --noEmit
```

```bash
cd crm-app/desktop && npm run build
```

Cả hai đều sạch lỗi. Chưa có kiểm thử tự động — đây là khoản nợ cần trả trước khi
đưa vào vận hành thật với dữ liệu bệnh nhân.
