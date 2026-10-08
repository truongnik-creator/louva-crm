# CLAUDE.md

Repo này là **Louva CRM** (phần mềm quản lý phòng khám thẩm mỹ). Quy tắc làm
việc đầy đủ nằm ở **[AGENTS.md](AGENTS.md)** — đọc hết tệp đó trước khi làm bất
cứ việc gì trong repo.

@AGENTS.md

---

## Bản rút gọn (chi tiết ở AGENTS.md)

1. **Preview trước, làm sau.** Trước khi triển khai một tính năng / thay đổi
   nghiệp vụ / thay đổi lược đồ CSDL: trình bày cách định làm theo khung 9 mục
   ở AGENTS.md mục 1, **chờ người dùng duyệt**. Sửa lỗi nhỏ, trả lời tra cứu,
   việc đã được chỉ rõ từng bước thì làm luôn.
2. **Mỗi tính năng một nhánh mới** `tinh-nang/<slug>`. Không bao giờ commit
   trực tiếp vào `main`.
3. **Xong thì trộn về `main`**, có xung đột thì **tự sửa, lặp đến khi hết** —
   giữ cả hai bên, không dùng `-X ours/theirs` để xoá việc của nhánh kia,
   không sửa migration cũ, sửa xong **chạy lại typecheck + test**.
4. **Merge thành công và đã push thì xoá nhánh** (`git branch -d`, và xoá cả
   nhánh trên origin).
5. **Rồi triển khai lên VPS**: `HOST=root@221.132.16.132 ./deploy/deploy.sh`,
   sau đó xác nhận `curl -fsS https://crm.louva.vn/health`.
6. **Dừng để hỏi** chỉ với việc không đảo ngược được: xoá/ghi đè dữ liệu thật
   trên VPS, đổi khoá mã hoá, migration xoá cột hay bảng đang có dữ liệu,
   `push --force` lên `main`, gửi/đăng nội dung ra ngoài, đổi DNS hay hạ tầng.

Cổng chất lượng trước mọi commit:

```bash
cd backend && npx tsc --noEmit && npx tsc -p tsconfig.test.json && npm test
cd desktop && npx tsc --noEmit -p tsconfig.web.json && npx vite build --config vite.web.config.mts
```

> Tệp này **ghi đè** `CLAUDE.md` ở thư mục cha `Brain2026/` (dành cho wiki cá
> nhân, "hành động, không hỏi nhiều", thư mục `raw/` bất biến). Repo `crm-app`
> không có `raw/`, và ở đây **bắt buộc preview trước khi triển khai**.
