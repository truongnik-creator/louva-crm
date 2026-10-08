# Louva CRM: phần mềm quản lý phòng khám thẩm mỹ (bản nâng cấp NOVA)

CRM cho phòng khám thẩm mỹ nội khoa (tiêm) và phẫu thuật: hộp thư gom Zalo, Pancake (Facebook, TikTok), lịch hẹn có cọc, hàng đợi lễ tân, hồ sơ điều trị và ảnh mã hoá, báo giá, hợp đồng, công nợ, kho vật tư, chăm sóc sau tiêm, đo lường marketing, lương thưởng theo coaching, và 6 tính năng AI có hàng rào pháp lý dữ liệu.

Bản hiện tại là nhánh `nang-cap-nova`: 54 hạng mục nâng cấp cho phòng khám tiêm NOVA (thương hiệu VÂN TRẦN DOUYIN, 2 cơ sở Hà Nội và TP.HCM). Danh sách từng hạng mục, trạng thái, tệp chính và các tham số chủ phòng khám phải xác nhận: **[docs/NANG-CAP-NOVA.md](docs/NANG-CAP-NOVA.md)**.

| Thành phần | Công nghệ |
|---|---|
| `backend/` | Node.js, Express 4, Prisma 5, SQLite, zod, socket.io, pino, vitest |
| `desktop/` | React 18 + TypeScript. Chạy hai kiểu: ứng dụng Electron, hoặc web app (PWA cài được trên điện thoại) do chính backend phục vụ |
| `docs/` | `schema_tmv.prisma` (lược đồ mục tiêu), `prototype_tmv.html` (đặc tả màn hình), `NANG-CAP-NOVA.md` (nhật ký nâng cấp) |

---

## Chạy thử trên máy phát triển

Cần Node.js 20 trở lên. Không cần cài CSDL: SQLite tự tạo, migration tự áp khi khởi động.

**1. Cài và nạp dữ liệu mẫu**

```bash
cd backend && npm install && SEED_DEMO=1 npx tsx prisma/seed.ts
```

Không có `SEED_DEMO=1` thì seed chỉ nạp danh mục (phòng ban, phòng, ca, kênh, 29 dịch vụ và bảng giá NOVA, mẫu tin), **không tạo tài khoản và khách demo**.

**2. Chạy backend** (cổng 4000)

```bash
cd backend && npm run dev
```

**3. Chạy giao diện**, chọn một trong hai:

```bash
cd desktop && npm install && npm run dev                                   # ứng dụng Electron
cd desktop && npx vite --config vite.web.config.mts                        # web, mở http://localhost:5173
```

Hoặc build bản web một lần rồi để backend phục vụ luôn ở `http://localhost:4000` (cùng origin với API, dùng được trên điện thoại cùng mạng LAN):

```bash
cd desktop && npx vite build --config vite.web.config.mts
```

**Tài khoản demo.** Mật khẩu chung `123456` (chỉ máy phát triển). Lần đăng nhập đầu **bắt buộc đổi mật khẩu**: mọi API nghiệp vụ trả 403 `MUST_CHANGE_PASSWORD` cho tới khi đổi. Muốn trình diễn nhanh trên máy cá nhân mà không phải đổi mật khẩu:

```bash
cd backend && SEED_DEMO=1 SEED_DEMO_KEEP_PASSWORD=1 npx tsx prisma/seed.ts
```

`SEED_DEMO_KEEP_PASSWORD` bị bỏ qua khi `NODE_ENV=production`. Ở production seed demo không bao giờ dùng `123456`: đặt `SEED_DEMO_PASSWORD` (tối thiểu 10 ký tự) hoặc để hệ thống sinh ngẫu nhiên và in ra một lần.

| Vai trò | Email | Thấy được gì |
|---|---|---|
| Giám đốc | `giamdoc@louva.vn` | Toàn bộ số liệu, dự báo, bản tin sáng |
| Quản lý cơ sở | `quanly@louva.vn` | Điều hành cơ sở, duyệt giảm giá, bản tin sáng của cơ sở |
| Lễ tân | `letan@louva.vn` | Lịch hẹn, cọc, check-in, thu tiền; **không có hồ sơ điều trị** |
| Tư vấn viên | `thuha@louva.vn` | Khách của mình, phiếu tư vấn, báo giá |
| Telesale | `minhngoc@louva.vn` | Chỉ khách mình phụ trách, nháp tin chăm lại, thư viện case |
| Bác sĩ | `bs.tuan@louva.vn` | Hồ sơ điều trị, ảnh, phiếu tư vấn, duyệt case |
| Điều dưỡng | `dd.nhung@louva.vn` | Chăm sóc sau tiêm, ảnh |
| Kế toán | `ketoan@louva.vn` | Hợp đồng, công nợ, xuất Excel kế toán |
| Marketing | `marketing@louva.vn` | Chỉ số quảng cáo; **SĐT khách bị che `09xx xxx 123`** |

Tài khoản quản trị hệ thống: `admin@louva.vn` / `admin123` trên máy phát triển. Khi `NODE_ENV=production` mà không đặt `ADMIN_PASSWORD`, mật khẩu quản trị đầu tiên được sinh ngẫu nhiên và in ra một lần lúc khởi động. Tên nhân viên, khách, số liệu demo đều là **dữ liệu mẫu**.

### Tạo tài khoản quản trị

Nhân viên thường thêm trên giao diện (*Người dùng & Phân quyền*). Script dưới đây cho tài khoản quản trị cấp cao hoặc khi **không ai đăng nhập được**:

```bash
cd backend && npx tsx scripts/create-admin.ts --email ceo@phongkham.vn --name "Tên chủ phòng khám"
```

Mặc định gán `GIAM_DOC` + `QUAN_LY_HE_THONG`, gán mọi cơ sở, sinh mật khẩu 20 ký tự in ra một lần, bắt buộc đổi mật khẩu lần đầu. Chạy lại với cùng email là cập nhật tài khoản đó và thu hồi mọi phiên; thêm `--keep-password` để giữ mật khẩu.

### Làm mới ngày của dữ liệu demo

Dữ liệu mẫu gắn với ngày chạy seed. Dời mọi mốc thời gian về hôm nay (giữ tài khoản):

```bash
cd backend && npx tsx scripts/refresh-demo-dates.ts
```

### Đổi tên phòng khám, thêm cơ sở

Tên lấy từ cơ sở đầu tiên. Đặt trước lần chạy đầu bằng `CLINIC_NAME`, `CLINIC_SHORT_NAME`, `CLINIC_CODE`, hoặc sửa ở Cài đặt sau đó. Mở thêm cơ sở qua `POST /api/org/branches`; ô chọn cơ sở tự hiện khi có từ 2 cơ sở. Thông tin chỉ đường, bãi xe, tài khoản nhận cọc của từng cơ sở khai ở Cài đặt, Thông tin cơ sở.

---

## Biến môi trường

Toàn bộ biến có trong [`backend/.env.example`](backend/.env.example) (không chứa bí mật nào). Chép thành `backend/.env` rồi điền. Máy phát triển có thể chạy không cần `.env`.

| Biến | Bắt buộc khi | Ý nghĩa |
|---|---|---|
| `NODE_ENV=production` | chạy thật | Bật các kiểm tra bảo mật production |
| `JWT_SECRET` | production | Tối thiểu 32 ký tự ngẫu nhiên. Thiếu, yếu hoặc trùng khoá mặc định thì server **từ chối khởi động** |
| `ENCRYPTION_KEY_FILE` | nên có | Tệp khoá mã hoá đặt ngoài thư mục `data` (xem mục Khoá mã hoá) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | tuỳ chọn | Tài khoản quản trị tạo lần đầu |
| `DATABASE_URL`, `STORAGE_DIR` | tuỳ chọn | Mặc định `backend/data/crm.db`, `backend/data/storage` |
| `PORT` | tuỳ chọn | Mặc định 4000 |
| `CORS_ORIGIN` | tuỳ chọn | Origin khác được gọi API (bản web cùng origin thì không cần) |
| `TRUST_PROXY` | tuỳ chọn | Mặc định `loopback`: chỉ tin `X-Forwarded-For` từ proxy cùng máy. Không đặt `true` |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS` | tuỳ chọn | Số lần đăng nhập sai mỗi IP (mặc định 10 lần / 15 phút) |
| `LOG_LEVEL` | tuỳ chọn | Mặc định `info`. Log JSON có `reqId`; xem đẹp: `npm run dev \| npx pino-pretty` |
| `BACKUP_DIR`, `BACKUP_KEEP` | tuỳ chọn | Nơi lưu và số bản sao lưu (mặc định 14) |
| `DISABLE_JOBS=1` | tuỳ chọn | Tắt bộ hẹn giờ tác vụ nền (khi chạy thêm tiến trình thử trên cùng CSDL) |
| `ANTHROPIC_API_KEY` | tuỳ chọn | Khoá Claude API cho AI1 đến AI6. Để trống thì AI tự tắt |
| `PANCAKE_WEBHOOK_SECRET`, `PANCAKE_TOKEN_MODE`, `PANCAKE_API_BASE` | khi dùng Pancake | Xem mục Pancake |
| `BANK_BIN`, `BANK_ACCOUNT_NO`, `BANK_ACCOUNT_NAME` | tuỳ chọn | Mặc định tài khoản nhận cọc (sửa được trong Cài đặt) |
| `SEED_DEMO`, `SEED_DEMO_KEEP_PASSWORD`, `SEED_DEMO_PASSWORD` | khi seed | Xem mục Chạy thử |

**Không bao giờ ghi khoá, mật khẩu thật vào repo.** `.env` đã nằm trong `.gitignore`.

### Chế độ phòng khám (`clinic.mode`)

Cài đặt hệ thống, tham số `clinic.mode`:

- `INJECTION` (mặc định, NOVA): ẩn phòng mổ, lịch mổ, hồ sơ phẫu thuật, truy vết implant; đổi nhãn "bệnh án" thành "hồ sơ điều trị", "hậu phẫu" thành "chăm sóc sau tiêm", "ca mổ" thành "ca thực hiện"; dùng bộ 7 bước bán hàng phòng khám tiêm.
- `SURGERY`: hiện lại toàn bộ tính năng phẫu thuật (không có gì bị xoá, chỉ ẩn).

### Cài đặt AI (tuỳ chọn)

1. Đặt `ANTHROPIC_API_KEY` trong `backend/.env`, khởi động lại backend.
2. Model dùng: `claude-haiku-4-5-20251001` cho việc rẻ (AI1 tách thông tin, AI3 tóm tắt, AI5 nháp tin, AI6 bản tin), `claude-sonnet-5` cho AI2 gợi ý trả lời và AI4 chấm hội thoại (`backend/src/lib/ai.ts`).
3. Bật tắt từng tính năng ở Cài đặt hệ thống, nhóm *Trí tuệ nhân tạo*.

Luật cứng (Nghị định 13/2023): khách chưa được ghi nhận đồng ý xử lý dữ liệu (mẫu ở Cài đặt, Mẫu biểu, có ghi rõ chuyển dữ liệu ra nước ngoài khi dùng AI) thì nội dung chat của khách không được gửi lên AI. Mỗi lần gọi AI ghi `DataAccessLog` loại `AI_PROCESSING`. Mọi gợi ý, nháp AI đều do người bấm gửi, không có gì tự gửi cho khách. Thiếu khoá thì giao diện báo "chưa cấu hình", nghiệp vụ vẫn chạy; bản tin sáng AI6 chuyển sang bản số liệu thuần.

### Pancake (Facebook, TikTok qua Pancake)

Khai kết nối ở Cài đặt. Trả lời hội thoại nguồn Pancake đi qua API Pancake. Webhook `POST /api/pancake/webhook` xác thực bằng `X-Pancake-Signature` (HMAC-SHA256 thân yêu cầu) hoặc `X-Webhook-Secret`. Nút đồng bộ tay vẫn giữ làm dự phòng.

> **TODO-VERIFY**: phần tích hợp Pancake dựng theo mô tả công khai, **chưa thử với tài khoản Pancake thật**. Các chỗ cần đối chiếu tài liệu API thật được đánh dấu `TODO-VERIFY` trong `backend/src/services/pancake.ts` và `backend/src/routes/pancake.ts` (đường dẫn API, token gửi qua header hay query `PANCAKE_TOKEN_MODE`, định dạng chữ ký webhook, trường nguồn quảng cáo, tải ảnh đính kèm).

---

## Dùng trên điện thoại (PWA)

Bản web (`vite.web.config.mts`) là web app cài được như ứng dụng:

- Giao diện co theo hai mốc 768px và 480px: menu thành ngăn kéo (nút ☰), hộp thư một cột (danh sách, hội thoại, hồ sơ khách, có nút quay lại), lịch hẹn, hàng đợi, việc của tôi, chăm sóc sau tiêm, trang chủ theo vai, đo lường, kỳ lương, tăng trưởng đọc được trên màn hình 390px; bảng rộng cuộn ngang trong khung.
- `manifest.webmanifest`, biểu tượng và service worker nằm ở `desktop/src/renderer/public-web/`. Service worker **chỉ lưu khung ứng dụng** (trang gốc, JS, CSS, biểu tượng). Yêu cầu `/api` và `/socket.io` đi thẳng ra mạng, **không bao giờ được lưu đệm** (dữ liệu khách, ảnh, SĐT không nằm lại trên máy).
- Chỉ bản web đăng ký service worker; bản Electron không.
- Cài trên điện thoại: mở trang qua **HTTPS** (hoặc localhost), trình duyệt, "Thêm vào màn hình chính". Qua HTTP thường trong LAN thì vẫn dùng web được nhưng không cài được như app.

## Truy cập từ xa qua Cloudflare Tunnel

> **KHÔNG dùng quick tunnel với dữ liệu thật** (khách, hồ sơ điều trị, ảnh). Link quick tunnel là công khai, không có lớp chặn nào phía trước. `share-remote.sh` luôn in cảnh báo và **từ chối chạy khi `NODE_ENV=production`**. Vận hành thật dùng named tunnel + Cloudflare Access, hoặc máy chủ riêng có TLS và tường lửa.

```bash
./share-remote.sh          # build web, chạy backend, mở đường hầm, in link https://….trycloudflare.com
./share-remote.sh url      # in lại link
./share-remote.sh stop     # tắt
```

Backend phục vụ luôn bản web đã build (`desktop/out/web`), nên giao diện và API **cùng một origin**: một đường hầm vào cổng 4000 là đủ, không vướng CORS, WebSocket tự lên `wss://`. Link quick tunnel đổi mỗi lần khởi động và chỉ sống khi máy còn bật.

---

## Sao lưu và khôi phục

```bash
cd backend && npm run backup
```

Tạo `backend/backups/louva-hang-ngay-<ngày-giờ>/` gồm `crm.db` (chụp bằng `VACUUM INTO`, an toàn khi server đang chạy), `storage/` (ảnh, chữ ký vẫn ở dạng mã hoá), `enc-key` (nếu khoá nằm trong tệp) và `manifest.json`. Tự giữ **14 bản** mới nhất (`BACKUP_KEEP`). Thêm `-- --no-key` để không chép khoá (khuyến nghị khi khoá đã sao lưu riêng).

Chạy hằng ngày lúc 2 giờ sáng bằng cron (`crontab -e`), sau đó chép `backups/` ra ổ khác hoặc lưu trữ ngoài máy:

```
0 2 * * * cd /đường/dẫn/louva-crm/backend && /usr/local/bin/npm run backup >> backups/backup.log 2>&1
```

**Tự sao lưu trước khi migrate:** mỗi lần khởi động, nếu có migration mới, `bootstrap.ts` chụp CSDL vào `backups/louva-truoc-migrate-<ngày-giờ>/` rồi mới áp migration (giữ 5 bản).

**Khôi phục** (tắt server trước):

```bash
cd backend && npm run restore -- --from backups/louva-hang-ngay-20260930-020000 --yes
```

Script giữ CSDL và kho tệp hiện tại bên cạnh (hậu tố `.truoc-khoi-phuc-<thời gian>`), không xoá gì. Khoá mã hoá chỉ chép đè khi thêm `--with-key`.

### Khoá mã hoá

Thứ tự: `ENCRYPTION_KEY` (64 ký tự hex), tệp `ENCRYPTION_KEY_FILE`, tệp mặc định `backend/data/.enc-key` (tự sinh lần chạy đầu). **Nên đặt `ENCRYPTION_KEY_FILE` ngoài thư mục `data`**, ví dụ `ENCRYPTION_KEY_FILE=/etc/louva/enc-key npm start`. Ở production nếu tệp khoá chỉ định không tồn tại thì server từ chối khởi động (tránh sinh khoá mới đè dữ liệu đã mã hoá).

> **Sao lưu khoá RIÊNG, cất ở nơi khác bản sao lưu CSDL.** Mất khoá là mất toàn bộ ảnh, chữ ký và token Zalo. Đổi khoá khi đã có dữ liệu cũng làm mất dữ liệu đó.

### Chuyển dữ liệu cũ

```bash
cd backend && npm run backup && npx tsx scripts/migrate-stages.ts          # xem trước chuyển bước khách sang bộ 7 bước
cd backend && npx tsx scripts/migrate-stages.ts --yes                       # ghi thật
```

Nhập khách cũ từ Excel, CSV ở Kinh doanh, Nhập khách từ Excel (quyền `customer.import`), chống trùng theo SĐT chuẩn hoá.

---

## Kiểm tra chất lượng và test

```bash
cd backend && npx tsc --noEmit && npx tsc -p tsconfig.test.json && npm test && npm audit --omit=dev
cd desktop && npx tsc --noEmit -p tsconfig.web.json && npx vite build --config vite.web.config.mts
```

`npm test` chạy vitest trên **CSDL riêng** `backend/data/test/test.db` (xoá và áp lại migration mỗi lần, không đụng `data/crm.db`), khoá JWT và khoá mã hoá sinh ngẫu nhiên. Test gọi API qua unix socket riêng của từng app (`tests/helpers.ts`), không gọi AI thật (`setAiClientForTests`).

Hiện có 14 tệp, 187 test: bảo mật và phân quyền (S1, S4, S5, S6), chuẩn hoá SĐT và gộp hồ sơ (B17), phân trang (T3), báo cáo (B1 đến B9), luồng thao tác (B10 đến B16), 7 bước và cọc (F1, F25), nhập khách và hộp thư (F4, F5, AI1), tự động hoá và giá (F8 đến F14, AI2, AI3), đo lường, lương thưởng, tăng trưởng (F15 đến F34, AI4), tư vấn và thư viện case (F30), AI5, AI6, PWA (F28).

Viết test mới: tạo `backend/tests/<ten>.test.ts`:

```ts
import { beforeAll, it, expect } from "vitest";
import { setupTestContext, uniquePhone, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestContext("tenfile");   // tiền tố riêng cho dữ liệu của tệp
  await ctx.createUser("LE_TAN");
});

it("ví dụ", async () => {
  const c = await ctx.createCustomer({ name: "Khách thử", phone: uniquePhone() });
  const res = await ctx.as("LE_TAN").get(`/api/customers/${c.id}`);
  expect(res.status).toBe(200);
});
```

Thay đổi lược đồ luôn bằng **migration mới** (`npx prisma migrate dev --name ...`), không sửa migration cũ.

---

## Các phân hệ và màn hình

### Nền tảng (Lô 1, Lô 2)

- **Bảo mật**: phiên thu hồi được (access 15 phút, refresh 7 ngày xoay vòng, phát hiện tái sử dụng token), RBAC ba cổng vai trò, cơ sở, phạm vi (`ALL` / `BRANCH` / `OWN`; vượt phạm vi trả 404), cách ly hồ sơ điều trị theo cơ sở, xem chéo phải break-glass có lý do. `AuditLog` ghi thay đổi, `DataAccessLog` ghi cả hành vi chỉ đọc. Ảnh, chữ ký, token Zalo mã hoá AES-256-GCM. Che SĐT với vai không có `customer.view_phone` (kể cả phản hồi lồng, socket, tệp xuất). Tư vấn viên, telesale không nhận dữ liệu y khoa nhạy cảm. Giới hạn đăng nhập sai và khoá tạm tài khoản. Tải lên chỉ nhận ảnh, PDF (kiểm đuôi, MIME, byte đầu). Electron bật sandbox, token lưu bằng `safeStorage`.
- **Dữ liệu**: SĐT chuẩn hoá `0xxxxxxxxx` (cột `phoneNormalized` có index), chống trùng, cảnh báo tên gần giống, màn gộp hồ sơ trùng giữ toàn bộ lịch sử. Phân trang chung cho mọi danh sách. Log JSON có request id. Giờ nghiệp vụ theo Asia/Ho_Chi_Minh.
- **Báo cáo đã sửa**: loại hợp đồng huỷ, gom theo kênh, gom ngày giờ Việt Nam, lọc theo cơ sở, thực thu trong kỳ, công nợ so số dư đầu kỳ, tỉ lệ không đến đúng mẫu số, công suất theo bác sĩ và cơ sở.
- **Luồng thao tác**: đặt lịch thẳng từ hộp thư, gắn hội thoại vào hồ sơ ngay trong hộp thư, mẫu tin nhanh có biến `{{...}}` (màn *Mẫu tin nhanh*), ảnh và tệp trong khung chat, chữ ký tay trên màn hình.

### Đợt 1: dữ liệu đúng và đủ (Lô 3)

- **7 bước bán hàng** Tiếp cận, Nhắn tin, Có ảnh, Lịch cọc, Đến cơ sở, Làm dịch vụ, Quay lại, cộng Mất khách (bắt buộc lý do); tự chuyển bước theo sự kiện; bảng kéo thả `/bang-buoc-khach`.
- **Ảnh khách gửi qua chat** tự tải, mã hoá, lưu hồ sơ; cờ đồng ý dùng ảnh làm marketing (chỉ bác sĩ, quản lý bật, có audit).
- **Nhập khách cũ** từ Excel, CSV (`/nhap-khach`).
- **Pancake**, **chế độ phòng khám tiêm** với 29 dịch vụ và bảng giá NOVA, **gửi vị trí và bảng giá chuẩn** từ hộp thư.
- **Cọc gắn lịch hẹn**: mã VietQR theo mã lịch, lễ tân xác nhận cọc một nút, tự trừ cọc khi thanh toán, báo cáo tỉ lệ cọc.
- **AI1**: tách SĐT, tên, nhu cầu từ tin nhắn (regex trước, AI sau), sale bấm "Áp dụng" mới ghi hồ sơ.

### Đợt 2: tự động hoá và bán hàng (Lô 4)

- **Tác vụ nền** trong tiến trình backend, khoá chống chạy chồng, bảng `job_runs`; màn *Nhật ký tác vụ & Tự động hoá* (`/nhat-ky-tac-vu`).
- **8 quy tắc tự động**: tin chờ quá lâu, tin có từ khoá y khoa, giá lệch niêm yết, kẹt bước Có ảnh, lịch ngày mai, quá giờ hẹn, chăm sóc sau thực hiện, mốc tái tiêm.
- **Chăm sóc sau tiêm** D0, D1, D3, D7, D14, D30 và tái tiêm theo dịch vụ (`/hau-phau`).
- **Nhóm khách và gửi tin theo kịch bản** (`/gui-tin-theo-nhom`): giới hạn mỗi giờ, loại khách từ chối nhận tin, ngoài cửa sổ 24 giờ Facebook thì tạo việc cho sale.
- **Giá và giảm giá** (`/uu-dai`, `/duyet-giam-gia`): đợt ưu đãi có suất, trần giảm theo vai, vượt trần chờ duyệt, báo cáo rò rỉ chiết khấu.
- **Hộp thư theo ca**: lọc của tôi, chưa đọc, chưa phân công, theo kênh; đồng hồ chờ; chia xoay vòng; nhãn và ghi chú nội bộ. **Việc của tôi hôm nay** (`/viec-cua-toi`).
- **AI2** gợi ý trả lời theo kịch bản (`/kich-ban-ban-hang`, hàng rào hai lớp), **AI3** tóm tắt hội thoại.

### Đợt 3: đo lường, lương thưởng, tăng trưởng (Lô 5)

- **Đo lường & Họp cuối ngày** (`/do-luong`): chỉ số tuần theo chiến dịch và kênh, nhập chi phí quảng cáo tay hoặc CSV Meta, TikTok, họp cuối ngày theo sale, thi đua, tốc độ trả lời so tỉ lệ chốt, lãi gộp, quay lại và tái tiêm, trọn đời theo kênh, chỉ tiêu và dự báo, xuất Excel kế toán không giới hạn dòng.
- **Kỳ lương theo coaching** (`/ky-luong`): lương cứng theo bậc khách đến, thưởng doanh số (mốc hoặc % bậc), bán full và bán phần, upsale, % người chạy ads; chỉ tiền đã thu trong kỳ; khoá kỳ, xuất Excel.
- **Giới thiệu, voucher, quà, thi đua** (`/tang-truong`); **AI4** chấm hội thoại tuần (`/cham-hoi-thoai`, không nối vào lương).
- **Trang chủ theo vai** cho bác sĩ, điều dưỡng, lễ tân, sale, marketing, kế toán, giám đốc.

### Sau 90 ngày (Lô 6)

- **Dùng trên điện thoại, PWA** (xem mục riêng ở trên).
- **Tư vấn & Phác đồ** (`/tu-van`, quyền `consultation.*`): phiếu tư vấn dùng tốt trên máy tính bảng, chạm chọn vùng mặt, dịch vụ đề xuất lấy từ bảng giá (kèm giá niêm yết), sản phẩm, liều theo 0,1 đơn vị, chụp ảnh "trước" bằng camera lưu vào bộ ảnh mốc CONSULT; lập phác đồ từ đề xuất; lập báo giá theo giá niêm yết từ phác đồ hoặc gắn báo giá sẵn có. Bác sĩ, tư vấn viên, quản lý lập phiếu; vai khác chỉ xem.
- **Thư viện case** (`/thu-vien-case`, quyền `case_study.*`): chỉ ảnh thuộc bộ ảnh đã bật đồng ý marketing, ẩn danh hoàn toàn (không tên, SĐT, mã khách; nhãn "Nữ, 30 đến 34 tuổi"), lọc theo dịch vụ. Case cần hai cổng duyệt (chuyên môn, truyền thông) mới hiện cho sale. Tắt đồng ý là ảnh biến khỏi thư viện ngay.
- **AI5 Chăm lại khách im lặng** (`/cham-lai-khach`, quyền `inbox.reengage`): tác vụ nền mỗi ngày soạn nháp cho khách im lặng quá `ai.reengageSilentDays` ngày (bộ lọc nhóm khách của F11), chỉ khách đã đồng ý dữ liệu và không từ chối nhận tin, không gửi tên, SĐT khách lên AI. Nháp vào hàng chờ; sale phụ trách đọc, sửa, bấm duyệt thì tin vào hàng đợi gửi theo nhóm (tôn trọng từ chối nhận tin và cửa sổ 24 giờ).
- **AI6 Bản tin sáng** (trang chủ giám đốc, quản lý cơ sở + thông báo): 7h00 giờ Việt Nam tổng hợp số liệu hôm qua và tiến độ tháng, chỉ con số tổng, không thông tin cá nhân khách; AI chưa cấu hình thì gửi bản số liệu thuần.

Mục *Đào tạo & Chứng chỉ* vẫn là màn "sắp có" (ngoài phạm vi 54 hạng mục).

---

## Cấu trúc mã nguồn

```
backend/
  prisma/schema.prisma, migrations/   lược đồ SQLite; mỗi thay đổi là một migration mới
  prisma/seed.ts                      danh mục, bảng giá NOVA, dữ liệu demo (SEED_DEMO=1)
  src/app.ts, src/index.ts            dựng Express (dùng chung server và test), khởi động, đăng ký tác vụ nền
  src/lib/                            nghiệp vụ dùng chung: ai, jobs, automation, broadcast, pricing,
                                      stages, deposit, analytics, metrics, payroll, growth,
                                      consultation, reengage (AI5), briefing (AI6), settings-catalog, ...
  src/middleware/                     auth, rbac (ba cổng, che SĐT), errorHandler
  src/routes/                         32 nhóm API (/api/...), trong đó Lô 6: consultations, cases, reengage
  src/services/                       Zalo, Pancake, gửi tin ra kênh
  scripts/                            backup, restore, create-admin, refresh-demo-dates, migrate-stages
  tests/                              vitest + supertest trên CSDL test riêng
desktop/
  src/main, src/preload               vỏ Electron
  src/renderer/src/                   React: pages (44 màn), components, lib (api theo lô), styles (theme, mobile)
  src/renderer/public-web/            manifest, biểu tượng, service worker (chỉ bản web)
  vite.web.config.mts                 build bản web vào out/web (backend phục vụ)
docs/NANG-CAP-NOVA.md                 nhật ký 54 hạng mục và tham số chờ chủ xác nhận
```

### Chuyển sang PostgreSQL sau này

Đang chạy SQLite để không phải cài CSDL. Quy ước giữ sẵn để đổi cơ học: trạng thái là `String` liệt kê ở `src/types/enums.ts` (đổi thành enum thật), tiền là `Int` đơn vị đồng (đổi `Decimal`), danh sách lưu JSON chuỗi (đổi `JSONB`), kho tệp mã hoá cục bộ `src/lib/storage.ts` (đổi thân hàm sang S3/R2), socket.io một tiến trình (thêm Redis adapter ở `src/socket/index.ts`), tác vụ nền đã có khoá CSDL nên chạy được nhiều tiến trình.

---

## Việc cần xác minh với tài khoản thật

Code đã chạy và qua test với dữ liệu giả; các điểm dưới đây **chưa thể kiểm** nếu không có tài khoản, thiết bị, dữ liệu thật:

1. **Pancake**: đối chiếu các chỗ `TODO-VERIFY` với tài liệu API Pancake thật (đường dẫn, token header hay query, chữ ký webhook, nguồn quảng cáo, ảnh đính kèm); thử nhận và trả lời tin Facebook, TikTok.
2. **Zalo OA**: kết nối OA thật từng cơ sở, thử webhook, gửi tin, tải ảnh.
3. **Claude API**: đặt khoá thật, xác nhận hai tên model trong `backend/src/lib/ai.ts` dùng được với tài khoản; thử AI1 đến AI6 với khách đã ký đồng ý; theo dõi chi phí (giới hạn `ai.reengageDailyLimit`, `ai.scoringBatchSize`).
4. **VietQR**: quét mã với tài khoản ngân hàng thật của từng cơ sở.
5. **CSV chi phí quảng cáo** Meta, TikTok thật; **tệp xuất kế toán** với kế toán và Misa.
6. **Điện thoại thật** (iPhone, Android, máy tính bảng) qua HTTPS: cài PWA, hộp thư một cột, chụp ảnh trước ở phiếu tư vấn.
7. **Vận hành**: cron sao lưu hằng ngày, thử khôi phục, cất khoá mã hoá riêng; đặt `NODE_ENV=production`, `JWT_SECRET`, `ENCRYPTION_KEY_FILE`; không dùng quick tunnel với dữ liệu thật.
8. **Tham số kinh doanh**: chủ phòng khám rà và chốt toàn bộ bảng tham số trong [docs/NANG-CAP-NOVA.md](docs/NANG-CAP-NOVA.md) (trần giảm giá, số ngày tái tiêm, tỉ lệ bán phần 50%, thưởng giới thiệu 500.000đ và hạn 90 ngày, mục tiêu thi đua đội đang là 0, bậc lương thưởng, ...).
