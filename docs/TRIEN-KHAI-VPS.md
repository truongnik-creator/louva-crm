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

## Bước 2 — Tên miền trên Cloudflare

Tên miền: `louva.vn`, zone đã tạo trên Cloudflare (`damian.ns.cloudflare.com`,
`kenia.ns.cloudflare.com`). CRM đặt ở `crm.louva.vn` để apex còn dành cho web
giới thiệu.

Trong Cloudflare, **DNS → Records → Add record**:

| Type | Name | IPv4 address | Proxy status |
|---|---|---|---|
| A | `crm` | `221.132.16.132` | **DNS only** (mây xám) |

### Vì sao DNS only, không bật proxy

Bật proxy (mây cam) thì Cloudflare giải mã TLS ở biên của họ, nên **toàn bộ
bệnh án, ảnh trước-sau và số điện thoại khách đi qua hạ tầng Cloudflare ở nước
ngoài**. Với dữ liệu sức khoẻ thuộc Nghị định 13/2023 đó là chuyển dữ liệu ra
nước ngoài, phải có cơ sở pháp lý và ghi trong mẫu đồng ý. Để mây xám thì TLS
đi thẳng từ trình duyệt tới máy chủ phòng khám, không ai ở giữa.

Đổi lại, mây xám để lộ IP máy chủ và không có lớp chắn DDoS. Với một CRM nội bộ
chỉ nhân viên phòng khám dùng, đánh đổi đó là hợp lý: đã có tường lửa và giới
hạn đăng nhập.

**Nếu vẫn muốn bật proxy** thì phải làm đủ ba việc, nếu không sẽ hỏng thật:

1. **SSL/TLS → Overview → Full (strict)**. Để `Flexible` thì Cloudflare gọi
   máy chủ bằng HTTP trong khi nginx đã chuyển hướng sang HTTPS, kết quả là
   vòng lặp chuyển hướng vô tận.
2. Dựng với `CF_PROXY=1` để nginx lấy IP khách từ `CF-Connecting-IP`. Thiếu
   bước này, backend coi mọi người là IP biên Cloudflare: **giới hạn đăng nhập
   10 lần / 15 phút sẽ tính gộp cả phòng khám vào vài IP, một người gõ sai mật
   khẩu là khoá cả nhà**, và nhật ký kiểm toán ghi sai IP nên không truy vết
   được ai đã xem bệnh án nào.
3. Cloudflare giới hạn thân yêu cầu 100 MB ở gói miễn phí — ảnh trước-sau chụp
   nhiều tấm một lượt có thể vượt.

### Chờ nameserver lan xong

Nameserver đang chuyển từ `tenten.vn` sang Cloudflare, chưa lan hết. Kiểm:

```bash
dig @1.1.1.1 +short A crm.louva.vn   # phải ra 221.132.16.132
dig @8.8.8.8 +short A crm.louva.vn   # phải ra 221.132.16.132
```

**Cả hai** phải trả về đúng IP trước khi sang bước 3. Certbot xác thực qua
HTTP-01: tên miền chưa trỏ đúng thì nó không cấp được chứng thư.

## Bước 3 — Dựng máy chủ (một lần)

```bash
SHA=$(git rev-parse HEAD) && ssh louva-vps "curl -fsSL https://raw.githubusercontent.com/truongnik-creator/louva-crm/$SHA/deploy/provision.sh -o /root/provision.sh && DOMAIN=crm.louva.vn ADMIN_EMAIL=truongnik@gmail.com bash /root/provision.sh"
```

**Lấy theo SHA commit, không lấy theo `main`.** `raw.githubusercontent.com` cache
tệp vài phút, nên `/main/` hay trả bản cũ ngay sau khi push — đã mất hai lần
chạy vì đúng lỗi này. URL theo SHA là bất biến nên không bao giờ cache sai.

Đứng sau proxy Cloudflare thì thêm `CF_PROXY=1 SKIP_CERTBOT=1`: khách nhận
chứng thư hợp lệ của biên Cloudflare, chặng Cloudflare→máy chủ dùng chứng thư
tự ký, và nginx lấy IP khách thật từ `CF-Connecting-IP`.

### Nếu Cloudflare trả lỗi 522

522 là Cloudflare không mở được kết nối TCP tới máy chủ gốc. Phân biệt nhanh:

```bash
ssh louva-vps 'tail -5 /var/log/nginx/access.log'   # có IP dải Cloudflare không?
curl -sSk -o /dev/null -w "%{http_code}\n" https://221.132.16.132/health
```

- Máy chủ trả 200 nhưng access log **không có IP Cloudflare nào** → bản ghi A
  trong Cloudflare đang trỏ sai IP. Sửa lại cho đúng IP máy chủ.
- Access log có IP Cloudflare → vấn đề ở tầng TLS hoặc SSL/TLS mode, không
  phải 522.

Script làm: cài Node 20 + nginx + ufw, tạo user `louva`, sinh khoá mã hoá và
`JWT_SECRET` tại chỗ, clone repo, build backend và bản web, dựng systemd, lấy
chứng thư Let's Encrypt cho `crm.louva.vn` và bật tự gia hạn, bật tường lửa,
đặt cron sao lưu 2 giờ sáng. Chạy lại được nhiều lần: khoá và `.env` đã có thì
giữ nguyên.

## Bước 4 — Lấy mật khẩu quản trị đầu tiên

```bash
ssh louva-vps 'journalctl -u louva-crm --no-pager | grep -A4 "Khoi dong lan dau\|Khởi động lần đầu" | head'
```

In ra **một lần duy nhất** lúc khởi động đầu. Đăng nhập xong hệ thống buộc đổi
mật khẩu ngay. Nếu đã trôi mất, tạo lại tài khoản quản trị:

```bash
ssh louva-vps 'sudo -u louva bash -c "set -a; . /etc/louva/louva.env; set +a; cd /opt/louva/app/backend && npx tsx scripts/create-admin.ts --email truongnik@gmail.com --name \"Tên chủ phòng khám\""'
```

## Bước 5 — Nạp danh mục (tuỳ chọn)

Máy chủ mới chưa có dữ liệu nào. Nạp danh mục NOVA (phòng ban, phòng, ca, kênh,
29 dịch vụ, bảng giá, mẫu tin) mà **không** tạo khách demo:

```bash
ssh louva-vps "sudo -u louva bash -c 'set -a; . /etc/louva/louva.env; set +a; cd /opt/louva/app/backend && npx tsx prisma/seed.ts'"
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
| Sao lưu ngay | `ssh louva-vps "sudo -u louva bash -c 'set -a; . /etc/louva/louva.env; set +a; cd /opt/louva/app/backend && npx tsx scripts/backup.ts -- --no-key'"` |
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
