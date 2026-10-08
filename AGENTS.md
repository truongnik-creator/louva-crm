# AGENTS.md — quy tắc làm việc cho agent trên Louva CRM

Tệp này là **nguồn sự thật duy nhất** về cách làm việc trong repo `crm-app`
(Louva CRM, `github.com/truongnik-creator/louva-crm`). `CLAUDE.md` chỉ trỏ về đây.

Bối cảnh kỹ thuật, biến môi trường, danh sách màn hình, cách chạy test: xem
[README.md](README.md). Nhật ký 54+ hạng mục: [docs/NANG-CAP-NOVA.md](docs/NANG-CAP-NOVA.md).
Triển khai máy chủ: [docs/TRIEN-KHAI-VPS.md](docs/TRIEN-KHAI-VPS.md).

> Quy tắc trong tệp này **ghi đè** `CLAUDE.md` ở thư mục cha `Brain2026/`
> (tệp đó dành cho wiki cá nhân: "hành động, không hỏi nhiều", thư mục `raw/`
> bất biến). Repo `crm-app` **không** có `raw/`, và ở đây **bắt buộc trình bày
> trước khi triển khai** — xem mục 1.

---

## 1. Luật vàng: PREVIEW TRƯỚC, LÀM SAU

Trước khi viết dòng mã đầu tiên của **một tính năng, một thay đổi nghiệp vụ,
một thay đổi lược đồ CSDL, hay một thay đổi vận hành** — luôn trình bày cách
định triển khai và **chờ người dùng đồng ý**. Không tự ý bắt tay vào làm.

Bản preview gồm đúng các mục sau, ngắn gọn, bằng tiếng Việt:

```
## Tính năng: <tên>
1. Mục tiêu nghiệp vụ — ai dùng, giải quyết việc gì
2. Nhánh — tinh-nang/<slug>
3. Lược đồ CSDL — bảng/cột thêm hay sửa, tên migration mới (hoặc "không đổi")
4. Backend — tệp nào, API nào (đường dẫn + phương thức), quyền RBAC nào
5. Frontend — màn nào, route nào, tệp nào
6. Quyền & bảo mật — vai nào thấy, có dữ liệu y khoa / SĐT / ảnh không
7. Test — tệp test nào, kiểm những gì
8. Tài liệu — mục nào trong README.md và docs/NANG-CAP-NOVA.md sẽ cập nhật
9. Rủi ro — chỗ dễ vỡ, dữ liệu đang chạy có bị ảnh hưởng không
```

**Không cần preview** (làm luôn, báo cáo sau): sửa lỗi gõ sai, sửa lỗi đã được
chỉ rõ cách sửa, đọc mã trả lời câu hỏi, chạy test, chạy typecheck, trả lời
tra cứu, và những việc người dùng đã nêu rõ từng bước.

Người dùng nói "làm luôn", "khỏi preview", "ok triển khai" → coi là đã duyệt
cho đúng việc đó, không suy rộng ra việc sau.

---

## 2. Quy trình bắt buộc cho mỗi tính năng

Sau khi bản preview được duyệt, chạy đủ 7 bước dưới, **không bỏ bước nào**.

### Bước 1 — Tạo nhánh mới

Luôn làm trên nhánh riêng. **Không bao giờ commit trực tiếp vào `main`.**

```bash
git switch main && git pull --ff-only origin main
git switch -c tinh-nang/<slug>
```

Quy ước tên nhánh: không dấu, chữ thường, nối bằng `-`.

| Loại việc | Tiền tố | Ví dụ |
|---|---|---|
| Tính năng mới | `tinh-nang/` | `tinh-nang/bao-cao-cong-no-theo-sale` |
| Sửa lỗi | `sua-loi/` | `sua-loi/che-sdt-trong-tep-xuat` |
| Vận hành, triển khai | `trien-khai/` | `trien-khai/cron-sao-luu` |
| Tài liệu | `tai-lieu/` | `tai-lieu/huong-dan-pancake` |

Nếu cây làm việc đang bẩn (`git status` có thay đổi chưa commit chưa thuộc việc
này): dừng lại, hỏi người dùng muốn xử lý thế nào. Không tự `stash`, không tự
`checkout --` lên thay đổi của người khác.

### Bước 2 — Viết mã theo đúng bản preview đã duyệt

Lệch khỏi bản preview (phải thêm bảng, phải đổi API, phát hiện cách làm khác
tốt hơn) → **nói trước, không âm thầm làm khác**.

Quy ước mã nguồn của repo này:
- Thay đổi lược đồ **luôn là migration mới** (`npx prisma migrate dev --name ...`).
  **Không bao giờ sửa migration đã có trong `backend/prisma/migrations/`.**
- Tiền là `Int` đơn vị đồng. Trạng thái là `String` liệt kê ở `backend/src/types/enums.ts`.
- Mọi API mới phải đi qua ba cổng RBAC (vai, cơ sở, phạm vi) ở `backend/src/middleware/rbac.ts`;
  vượt phạm vi trả 404, không trả 403 (không tiết lộ sự tồn tại của hồ sơ).
- Vai không có `customer.view_phone` phải nhận SĐT đã che — kể cả trong phản hồi
  lồng nhau, sự kiện socket, và tệp xuất.
- Ảnh, chữ ký, token kênh: mã hoá qua `backend/src/lib/storage.ts`, không lưu thô.
- Gửi dữ liệu khách lên AI: chỉ khi khách đã ghi nhận đồng ý, và phải ghi
  `DataAccessLog` loại `AI_PROCESSING` (Nghị định 13/2023).
- Giao diện, nhãn, thông báo lỗi cho người dùng: **tiếng Việt**.
- Màn mới phải đọc được ở màn hình 390px (xem mục PWA trong README).

### Bước 3 — Kiểm tra chất lượng (phải xanh hết mới đi tiếp)

```bash
cd backend && npx tsc --noEmit && npx tsc -p tsconfig.test.json && npm test
cd desktop && npx tsc --noEmit -p tsconfig.web.json && npx vite build --config vite.web.config.mts
```

Có tính năng mới mà không có test mới → chưa xong. Test nằm ở
`backend/tests/<ten>.test.ts`, dùng `setupTestContext` (mẫu trong README).

### Bước 4 — Cập nhật tài liệu, rồi commit

- `README.md`: thêm hoặc sửa mục tương ứng nếu tính năng người dùng thấy được.
- `docs/NANG-CAP-NOVA.md`: thêm dòng vào bảng hạng mục (mục, trạng thái, tệp chính, ghi chú).

Commit theo giọng của repo: tiếng Việt, mô tả **việc đã làm và vì sao**, không
chỉ liệt kê tệp. Nhiều commit nhỏ theo bước logic tốt hơn một commit khổng lồ.

```
F36 Báo cáo công nợ theo sale phụ trách

Kế toán phải lọc tay từng sale. Thêm groupBy=owner cho /reports/debt,
chặn vai không có quyền xem SĐT thấy số khách.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**Không commit**: `.env`, bất kỳ thứ gì trong `**/data/`, `backups/`, `*.db`,
`*.log`, tệp khoá mã hoá, token thật, mật khẩu thật, dữ liệu khách thật.
`.gitignore` đã chặn, nhưng không bao giờ `git add -f` để vượt qua.

### Bước 5 — Trộn về `main`, tự xử lý xung đột đến khi hết

```bash
git switch main && git pull --ff-only origin main
git merge --no-ff tinh-nang/<slug>
```

Có xung đột thì **tự sửa, lặp đến khi sạch** — không hỏi lại, không bỏ dở,
không `git merge --abort` rồi báo thất bại. Nguyên tắc sửa:

- **Giữ cả hai ý nghĩa.** Mặc định là hợp nhất hai bên, không chọn một bên bỏ
  một bên. Tuyệt đối không dùng `-X ours`/`-X theirs` hay `--strategy=ours` để
  xoá công việc của nhánh kia cho nhanh.
- `backend/prisma/schema.prisma`: hợp nhất thủ công — giữ **toàn bộ** model và
  field của cả hai bên. Nếu hai nhánh cùng thêm một field khác kiểu, dừng và hỏi.
- `backend/prisma/migrations/`: hai nhánh thêm hai thư mục migration khác nhau
  thì giữ cả hai, **không sửa, không xoá, không đổi tên** migration cũ. Nếu thứ
  tự áp sai (migration của mình giả định cột mà migration kia mới thêm), tạo
  **migration mới** đặt sau để chỉnh, không sửa cái cũ.
- `*.md` (README, NANG-CAP-NOVA): giữ cả hai mục/dòng bảng, xếp lại cho đúng thứ tự.
- `package-lock.json`: lấy bản `main` rồi chạy lại `npm install` ở package đó để
  sinh lại khoá (`git checkout --theirs` cho lock là ngoại lệ duy nhất chấp nhận được).
- Tệp mã nguồn: đọc **cả hai** phía, viết lại đoạn hợp nhất, xoá hết dấu
  `<<<<<<<`, `=======`, `>>>>>>>`. Grep lại cho chắc:
  `git grep -n '^<<<<<<<\|^>>>>>>>' -- . && echo "CÒN XUNG ĐỘT"`
- Sửa xong: **chạy lại toàn bộ Bước 3** (typecheck + test + build web). Test đỏ
  sau merge là xung đột ngữ nghĩa, phải sửa tiếp — không được commit merge khi
  còn đỏ.
- Rồi `git add -A && git commit` (giữ thông điệp merge, ghi thêm một dòng nói đã
  hợp nhất những gì nếu xung đột đáng kể).

```bash
git push origin main
```

### Bước 6 — Xoá nhánh

Chỉ sau khi merge đã vào `main` và `main` đã push thành công:

```bash
git branch -d tinh-nang/<slug>
git push origin --delete tinh-nang/<slug> 2>/dev/null || true
```

`git branch -d` (chữ thường) từ chối xoá nhánh chưa merge — đó là lưới an toàn,
**không đổi sang `-D`** để vượt qua. Nó từ chối nghĩa là merge chưa thật xong.

### Bước 7 — Triển khai lên VPS

```bash
HOST=root@221.132.16.132 ./deploy/deploy.sh
```

Script tự chạy typecheck + test ở máy cá nhân trước, rồi SSH vào máy chủ,
`git reset --hard origin/main`, `npm ci`, build backend và bản web, khởi động lại
`louva-crm`, và chờ `/health` trả lời (tối đa 60s). Có thể đặt sẵn `HOST` vào
`deploy/target.env` để khỏi gõ mỗi lần.

Máy chủ lấy mã từ `origin/main`, nên **chưa push thì deploy không có gì mới**.

Xác nhận sau khi deploy — luôn làm, đừng chỉ tin script:

```bash
curl -fsS https://crm.louva.vn/health
ssh louva-vps 'systemctl is-active louva-crm; journalctl -u louva-crm -n 20 --no-pager'
```

Deploy chết giữa đường (thường ở bước build): máy chủ đang ở trạng thái lệch
(mã mới, `dist` cũ). Sửa nguyên nhân, commit, push, **chạy lại `deploy.sh`** —
đừng để nguyên. Nếu không sửa nhanh được thì quay về commit trước và deploy lại
commit đó, và báo người dùng.

`bootstrap.ts` tự chụp CSDL vào `backups/louva-truoc-migrate-<ngày-giờ>/` trước
khi áp migration mới, nên deploy có migration vẫn có đường lùi.

---

## 3. Việc PHẢI dừng để hỏi (ngoại lệ của "tự làm")

- Xoá hoặc ghi đè dữ liệu thật trên VPS: `/var/lib/louva/crm.db`, `/var/lib/louva/storage`,
  `/etc/louva/enc-key`, `/var/backups/louva`.
- Đổi hoặc sinh lại khoá mã hoá khi đã có dữ liệu (mất khoá = mất toàn bộ ảnh,
  chữ ký, token).
- Migration **xoá bảng, xoá cột, hoặc đổi kiểu** cột đang có dữ liệu.
- `git push --force` lên `main`, `git reset --hard` khi có việc chưa commit,
  xoá nhánh chưa merge.
- Dùng quick tunnel (`share-remote.sh`) với dữ liệu thật.
- Gửi, đăng, hoặc chia sẻ bất cứ thứ gì ra ngoài: tin cho khách, bài đăng, tệp
  xuất chứa dữ liệu khách.
- Thay đổi hạ tầng ngoài repo: DNS Cloudflare, tường lửa, chứng thư TLS, cron
  trên máy chủ.

Ngoài danh sách này, trong phạm vi tính năng đã được duyệt preview: **tự quyết
và làm tiếp**, ghi giả định bằng một dòng ngắn trong báo cáo.

---

## 4. Báo cáo khi xong

Sau Bước 7, báo cáo ngắn đúng khung này:

```
Xong: <tên tính năng>
- Nhánh: tinh-nang/<slug> → đã merge vào main (<sha>) → đã xoá
- Thay đổi: <2-4 dòng>
- Migration: <tên> | không có
- Test: <n> tệp, <m> test — xanh
- Tài liệu: README mục <...>, NANG-CAP-NOVA hạng mục <...>
- Deploy: đã lên crm.louva.vn, /health OK lúc <giờ>
- Xung đột khi merge: <tệp nào, đã hợp nhất thế nào> | không có
- Còn phải kiểm với tài khoản/dữ liệu thật: <nếu có>
```

Báo cáo trung thực: test đỏ thì nói đỏ kèm output; bỏ bước nào thì nói rõ bước
đó và vì sao. Không báo "xong" khi chưa deploy và chưa xác nhận `/health`.
