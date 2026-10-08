# F36 · Báo cáo công việc hàng ngày từ trang tính Google

Bốn bộ phận **Media, MKT, Design, Content** ghi báo cáo công việc hàng ngày trên
trang tính Google riêng của từng người. Tài liệu này mô tả cách CRM lấy dữ liệu
đó về để theo dõi tiến độ, thay cho việc mở từng trang tính và đi nhắc gửi link.

Màn hình: **Nhân sự › Báo cáo công việc (trang tính)** — `/bao-cao-cong-viec`.

---

## 1. Mẫu trang tính

Mỗi nhân viên **một trang tính**, trong đó **12 sheet `T1`..`T12`** là 12 tháng.
Sheet phụ (`Quy trình Media`, ghi chú…) được bỏ qua khi đồng bộ — đó là tài liệu,
không phải dòng việc.

Bố cục một sheet tháng:

| Cột | Tiêu đề | Ghi chú |
|-----|---------|---------|
| A | `🕒Time` | `dd/MM/yyyy`. **Ô gộp** — chỉ điền ở dòng đầu mỗi ngày |
| B | (thứ) | `Thứ 5`, `CN`… |
| C | `🟠Kênh triển khai` | `TikTok`, `Fanpage`, `Khác`, `NGHỈ`… (chữ tự do) |
| D | `🔴Tên công việc` | |
| E | `▶️Tiến độ` | |
| F | `🔄️Trạng thái` | |
| G | `📶Đánh giá bài đăng` | `Chưa tốt` <5k · `Trung bình` ≥5k · `Tốt` ≥10k · `Xuất sắc` ≥50k view |
| H | `✅Link hoàn thành` | Ô có **siêu liên kết**, chữ hiện ra là "Link" |
| I | `🆙Take Note` | |
| J | `Tổng Kết` | |
| K | `Công/ngày` | Số công **tích luỹ**. Ô gộp, chỉ ở dòng đầu mỗi ngày |

Thêm hoặc bớt cột vẫn chạy: cột được **dò theo tiêu đề** (bỏ dấu, bỏ emoji), chỉ
rơi về vị trí A..K khi không dò ra.

---

## 2. Hai cách lấy dữ liệu

### ĐẨY (mặc định) — dùng cho trang tính ẨN

Apps Script nằm **trong chính trang tính**, chạy bằng quyền của chủ trang tính,
nên **không phải chia sẻ công khai và không phải cấp quyền gì cho CRM**.

```
Trang tính (ẩn)
  └─ Apps Script
       ├─ onEdit        → ghi dấu "có sửa" vào Script Properties (KHÔNG gọi mạng:
       │                   onEdit chạy mỗi lần gõ, gọi mạng ở đây là tự hết quota)
       ├─ mỗi 5 phút    → có dấu "có sửa" thì đẩy sheet vừa sửa
       └─ mỗi 2 giờ     → đẩy đủ 12 sheet (lưới an toàn, chống lệch dần)
            │
            │ POST /api/work-reports/ingest
            │ X-Report-Token: <token riêng của nguồn>
            ▼
          CRM
```

Cài đặt cho một nhân viên:

1. CRM › Báo cáo công việc › **Trang tính & kết nối** › **+ Gắn trang tính** —
   chọn nhân viên, dán link, chọn năm cho 12 sheet.
2. Bấm **Lấy mã Apps Script** → copy.
3. Mở trang tính của nhân viên › **Tiện ích mở rộng › Apps Script** → xoá mã cũ,
   dán mã mới.
4. Chọn hàm `setup` → **Chạy** → chấp nhận cấp quyền.
5. Về CRM bấm **Tải lại** — trạng thái phải chuyển sang *Đang chạy*.

> **Token hiện đúng một lần.** Mỗi lần mở lại "Lấy mã Apps Script" là **cấp token
> mới và token cũ chết ngay** (CRM chỉ lưu hash, không lưu token gốc). Lấy mã thì
> phải dán xong mới đóng. Không gửi mã qua nhóm chat chung.

Cần đặt **Cài đặt hệ thống › Tự động hoá › `workReport.publicBaseUrl`** thành địa
chỉ công khai của CRM (ví dụ `https://crm.congty.vn`). Để trống thì mã sinh ra lấy
theo địa chỉ của chính yêu cầu — đúng khi mở CRM qua tên miền thật, **sai nếu đang
mở qua `localhost`** vì Google không gọi được localhost.

### KÉO — chỉ dùng cho trang tính công khai

CRM tự đọc qua hai endpoint công khai của Google (`/htmlview` để liệt kê sheet,
`/gviz/tq?tqx=out:csv` để lấy ô). Tác vụ nền `work-report-pull` chạy 30 phút một
lần và chỉ kéo **tháng này + tháng trước**.

Dùng để xem thử trang tính mẫu, hoặc cho trang tính đã cố tình để công khai.

| | Đẩy | Kéo |
|---|---|---|
| Trang tính ẩn | ✅ | ❌ |
| Lấy được URL trong ô "Link hoàn thành" | ✅ | ❌ (chỉ còn chữ "Link") |
| Số dòng để nhảy đúng chỗ trong sheet | Chính xác | Có thể lệch nếu Google cắt dòng trắng đầu sheet |
| Cần cài đặt ở trang tính | Dán mã một lần | Không |
| Độ trễ | ~5 phút sau khi sửa | ≤30 phút |

---

## 3. Cách CRM hiểu dữ liệu

**Điền xuôi ngày.** Ô ngày là ô gộp nên Google chỉ trả giá trị ở dòng đầu; các
dòng việc tiếp theo của cùng ngày được gán lại ngày đó.

**KHÔNG điền xuôi `Công/ngày`.** Đó là số công của cả ngày; nhân ra từng dòng sẽ
đếm sai. Số công của tháng = **giá trị lớn nhất** (vì ô đó tích luỹ), không phải
tổng các ô.

**Phân biệt nghỉ với chưa điền.** Dòng có ngày mà trống nội dung: thứ là `CN` →
ngày nghỉ tuần; ngày thường → **chưa điền báo cáo**. Đây chính là con số "Trống"
trên lưới tháng.

**Chuẩn hoá chữ gõ tay** để đếm được, nhưng vẫn giữ nguyên chữ gốc:

| Mã | Nhận từ |
|---|---|
| `DONE` | hoàn thành, xong, đã đăng, done |
| `IN_PROGRESS` | đang làm, đang dựng, đang quay, doing |
| `LATE` | trễ, quá hạn, muộn |
| `PENDING` | chưa làm, chưa bắt đầu, todo |
| `CANCELLED` | huỷ, không làm, bỏ qua |
| `DAY_OFF` | cột kênh ghi `NGHỈ`, hoặc Chủ nhật để trắng |

Đánh giá bài đăng → `BAD` / `AVERAGE` / `GOOD` / `EXCELLENT`.

**Ghi = thay toàn bộ dòng của một sheet**, không hợp nhất từng dòng. Trang tính là
nguồn sự thật; chèn một dòng giữa tháng làm đổi số dòng của mọi dòng bên dưới nên
hợp nhất sẽ để lại dòng rác.

### Tiêu đề là ô gộp — điểm bẫy đã xử lý

Trên trang tính thật, ô tiêu đề `🕒Time` và `Công/ngày` là **ô gộp**: Google trả về
**rỗng** cho mọi dòng của vùng gộp, dù mắt người vẫn thấy tiêu đề. Dò theo chữ
không bao giờ ra hai cột này, và mất cột ngày là mất cả màn theo dõi tiến độ.

Cách xử lý: khi đã dò ra **ít nhất 3 cột** theo tiêu đề (tức bố cục chắc chắn khớp
mẫu), các cột còn thiếu được **vá theo vị trí mặc định** của mẫu. Cột đã bị vai
khác nhận thì không vá.

---

## 4. Phân quyền

Module **E5 — Báo cáo công việc theo trang tính**:

| Quyền | Việc |
|---|---|
| `work_report.read` | Xem báo cáo (theo phạm vi `ALL` / `BRANCH` / `OWN`) |
| `work_report.manage_source` | Gắn, đổi, ngắt trang tính; cấp lại token; lấy mã Apps Script |
| `work_report.sync` | Bấm kéo ngay, không chờ tác vụ nền |

Mặc định:

| Vai trò | `read` | `manage_source` | `sync` |
|---|---|---|---|
| Quản trị hệ thống | ALL | ✅ | ✅ |
| Giám đốc | ALL | ✅ | ✅ |
| Quản lý cơ sở | BRANCH | ✅ | ✅ |
| Marketing · Media · Design · Content | OWN | — | — |

Phạm vi `OWN` nghĩa là nhân viên chỉ thấy báo cáo của chính mình. **Trưởng bộ phận
cần xem cả nhóm** thì nâng `work_report.read` của vai trò đó lên `BRANCH` ở màn
*Người dùng & Phân quyền* — không phải sửa mã nguồn.

Cổng đẩy `/api/work-reports/ingest` **không đi qua phiên đăng nhập**: nó xác thực
bằng token riêng của nguồn (32 byte, lưu dạng hash SHA-256 như refresh token). Dán
mã của người này vào trang tính người khác bị trả **409** chứ không âm thầm ghi
sai chủ.

---

## 5. Vai trò và bộ phận mới

**Bộ phận** (tạo tự động ở mọi cơ sở khi khởi động): `MEDIA`, `MKT`, `DESIGN`,
`CONTENT`.

**Vai trò mới**: `MEDIA`, `DESIGN`, `CONTENT` — xem dịch vụ, case đã duyệt, hộp
thư, khách hàng (SĐT **bị che** vì không có `customer.view_phone`), và báo cáo
công việc của chính mình. `CONTENT` thêm `inbox.manage_scripts`.

Bộ phận **MKT dùng lại vai trò `MARKETING`** sẵn có — nó đã đúng việc (phễu, chiến
dịch, số liệu); thêm một vai "MKT" trùng chức năng chỉ làm bảng phân quyền rối.

Không vai trò nào trong bốn bộ phận này chạm được dữ liệu y khoa.

---

## 6. Vận hành

| Thứ | Ở đâu |
|---|---|
| Tác vụ nền | Cài đặt › Nhật ký tác vụ › `work-report-pull` |
| Bật/tắt kéo tự động | Cài đặt hệ thống › Tự động hoá › `workReport.autoPull.enabled` |
| Địa chỉ CRM cho Apps Script | Cài đặt hệ thống › Tự động hoá › `workReport.publicBaseUrl` |
| Nhật ký thao tác | Nhật ký kiểm toán, thực thể `WorkReportSource` |

**Ngắt kết nối** xoá dòng việc đã đồng bộ trong CRM và làm Apps Script nhận 401;
**trang tính trên Google không bị xoá**.

**Sang năm mới**: nếu nhân viên dùng lại cùng trang tính cho năm sau, sửa trường
*năm* của nguồn. Nếu lập trang tính mới thì đổi link — dòng việc cũ sẽ bị xoá vì
không còn ứng với trang tính nào.

### Khi có lỗi

| Dấu hiệu | Nguyên nhân thường gặp |
|---|---|
| Trạng thái *Chưa nhận dữ liệu* sau khi đã chạy `setup()` | `workReport.publicBaseUrl` trỏ vào localhost, hoặc máy chủ CRM không mở ra Internet |
| Apps Script báo `HTTP 401` | Token đã bị cấp lại ở CRM — lấy mã mới và dán lại |
| Apps Script báo `HTTP 409` | Mã đang dán trong trang tính của người khác |
| Kéo báo "Trang tính không đọc được bằng liên kết công khai" | Trang tính ẩn — chuyển sang chế độ đẩy |
| Cảnh báo "đang đọc theo vị trí cột mặc định" | Sheet mất dòng tiêu đề, hoặc tiêu đề bị sửa khác mẫu |

---

## 7. Mã nguồn

| Tệp | Việc |
|---|---|
| `backend/src/lib/work-report.ts` | Dò cột, phân tích dòng việc, chuẩn hoá chữ gõ tay |
| `backend/src/lib/work-report-sync.ts` | Ghi vào CSDL (dùng chung cho đẩy và kéo), token, kéo |
| `backend/src/lib/work-report-appsscript.ts` | Sinh mã Apps Script có URL + token sẵn |
| `backend/src/lib/work-report-jobs.ts` | Tác vụ nền kéo 30 phút |
| `backend/src/services/worksheet.ts` | Đọc trang tính công khai (gviz + htmlview) |
| `backend/src/routes/work-reports.ts` | API, gồm cổng đẩy không cần phiên |
| `desktop/src/renderer/src/pages/WorkReports.tsx` | Màn hình lưới tháng + chi tiết + kết nối |
| `backend/tests/f36-bao-cao-cong-viec.test.ts` | 22 test, chạy trên bản chụp **thật** của sheet mẫu |
