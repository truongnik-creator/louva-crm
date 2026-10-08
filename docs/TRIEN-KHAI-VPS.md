# Triển khai Louva CRM lên VPS

Máy chủ đích: Ubuntu 22.04, `221.132.16.132`. Bộ script ở `deploy/`.

Kiến trúc sau khi dựng:

```
Internet --443/TLS--> nginx --127.0.0.1:4000--> node (user louva, systemd)
                                                   |
                      /var/lib/louva/crm.db  <-----+  CSDL + kho ảnh mã hoá
                      /etc/louva/enc-key            khoá mã hoá (chmod 400)
                      /etc/louva/louva.env          JWT_SECRET, cấu hình
                      /var/backups/louva            sao lưu 2h sáng, giữ 14 bản
```

Cổng 4000 bị tường lửa chặn từ ngoài: chỉ nginx trên cùng máy gọi được.
`TRUST_PROXY=loopback` nên backend chỉ tin `X-Forwarded-For` từ nginx cục bộ,
giới hạn đăng nhập theo IP không bị giả mạo.

---

## Bước 1 — Cài khoá SSH (anh tự chạy, một lần)

Lệnh này sinh khoá trên máy anh rồi đẩy khoá công khai lên VPS. `ssh-copy-id`
sẽ hỏi mật khẩu root **một lần**; anh tự gõ, mật khẩu không đi qua script nào.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/louva-vps -N "" -C "louva-deploy" && ssh-copy-id -i ~/.ssh/louva-vps.pub -p 22 root@221.132.16.132
```

Rồi ghi vào `~/.ssh/config` để khỏi phải nhớ đường dẫn khoá:

```bash
printf 'Host louva-vps\n  HostName 221.132.16.132\n  User root\n  Port 22\n  IdentityFile ~/.ssh/louva-vps\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

Kiểm tra vào được mà không cần mật khẩu:

```bash
ssh -o BatchMode=yes louva-vps 'hostname; lsb_release -ds; free -h | head -2'
```

## Bước 2 — Dựng máy chủ (một lần)

**Có tên miền** (khuyến nghị — bắt buộc nếu muốn cài PWA lên điện thoại và
không muốn trình duyệt cảnh báo). Trỏ bản ghi A của tên miền về
`221.132.16.132` trước, đợi DNS lan, rồi:

```bash
ssh louva-vps 'curl -fsSL https://raw.githubusercontent.com/truongnik-creator/louva-crm/main/deploy/provision.sh -o /root/provision.sh && DOMAIN=crm.tenmien.vn ADMIN_EMAIL=ceo@tenmien.vn bash /root/provision.sh'
```

**Chưa có tên miền**: bỏ `DOMAIN=`, script dùng chứng thư tự ký. Dữ liệu vẫn
được mã hoá trên đường truyền, nhưng trình duyệt cảnh báo mỗi lần vào và PWA
không cài được như app. Chạy lại script với `DOMAIN=` sau là đủ để nâng lên
TLS thật, không mất dữ liệu.

Script làm: cài Node 20 + nginx + ufw, tạo user `louva`, sinh khoá mã hoá và
`JWT_SECRET`, clone repo, build backend và bản web, dựng systemd, cấu hình
nginx + TLS, bật tường lửa, đặt cron sao lưu. Chạy lại được nhiều lần
(idempotent): khoá và `.env` đã có thì giữ nguyên.

## Bước 3 — Lấy mật khẩu quản trị đầu tiên

```bash
ssh louva-vps 'journalctl -u louva-crm --no-pager | grep -A4 "Khoi dong lan dau\|Khởi động lần đầu" | head'
```

In ra **một lần duy nhất** lúc khởi động đầu. Đăng nhập xong hệ thống buộc đổi
mật khẩu ngay. Nếu đã trôi mất, tạo lại tài khoản quản trị:

```bash
ssh louva-vps 'cd /opt/louva/app/backend && sudo -u louva npx tsx scripts/create-admin.ts --email ceo@tenmien.vn --name "Tên chủ phòng khám"'
```

## Bước 4 — Nạp danh mục (tuỳ chọn)

Máy chủ mới chưa có dữ liệu nào. Nạp danh mục NOVA (phòng ban, phòng, ca, kênh,
29 dịch vụ, bảng giá, mẫu tin) mà **không** tạo khách demo:

```bash
ssh louva-vps 'cd /opt/louva/app/backend && sudo -u louva npx tsx prisma/seed.ts'
```

Đừng đặt `SEED_DEMO=1` trên máy chủ thật: cờ đó tạo khách và nhân viên giả.

---

## Cập nhật về sau

Từ máy cá nhân, sau khi đã push lên `main`:

```bash
HOST=louva-vps ./deploy/deploy.sh
```

Chạy typecheck và 235 test ở máy mình trước, rồi mới kéo mã trên máy chủ,
build lại, khởi động lại service. `bootstrap.ts` tự chụp CSDL vào
`/var/backups/louva` trước khi áp migration mới.

## Vận hành

| Việc | Lệnh |
|---|---|
| Trạng thái | `ssh louva-vps systemctl status louva-crm` |
| Log trực tiếp | `ssh louva-vps journalctl -u louva-crm -f` |
| Khởi động lại | `ssh louva-vps systemctl restart louva-crm` |
| Sao lưu ngay | `ssh louva-vps 'cd /opt/louva/app/backend && sudo -u louva npx tsx scripts/backup.ts -- --no-key'` |
| Danh sách bản sao lưu | `ssh louva-vps ls -lh /var/backups/louva` |
| Tải bản sao lưu về máy | `rsync -avz louva-vps:/var/backups/louva/ ./backup-tu-vps/` |

## Bắt buộc làm sau khi dựng

1. **Sao lưu `/etc/louva/enc-key` ra ngoài máy chủ**, cất khác chỗ với bản sao
   lưu CSDL. Mất tệp này là mất toàn bộ ảnh trước-sau, chữ ký, token Zalo —
   không có cách khôi phục. Cron sao lưu cố tình chạy `--no-key` để khoá không
   nằm chung với CSDL.

   ```bash
   scp louva-vps:/etc/louva/enc-key ./louva-enc-key-CAT-RIENG
   ```

2. **Tắt đăng nhập SSH bằng mật khẩu** (sau khi chắc chắn khoá vào được):

   ```bash
   ssh louva-vps 'sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && systemctl restart ssh'
   ```

3. **Đổi mật khẩu root**. Mật khẩu hiện tại đã bị dán vào một cuộc hội thoại,
   coi như đã rò rỉ:

   ```bash
   ssh louva-vps passwd
   ```

4. **Chép bản sao lưu ra ngoài máy chủ định kỳ**. `/var/backups/louva` nằm trên
   cùng ổ với CSDL: ổ chết là mất cả hai.

5. Dữ liệu khách và bệnh án chịu Nghị định 13/2023. Trước khi nhập dữ liệu thật
   phải có mẫu đồng ý xử lý dữ liệu (Cài đặt, Mẫu biểu), và nếu bật AI thì mẫu
   phải ghi rõ việc chuyển dữ liệu ra nước ngoài.

## Không dùng cho máy chủ thật

`share-remote.sh` (Cloudflare quick tunnel) tạo link công khai không có lớp
chặn nào. Nó tự từ chối chạy khi `NODE_ENV=production`. Máy chủ này đã có nginx
+ TLS + tường lửa, không cần đường hầm.
