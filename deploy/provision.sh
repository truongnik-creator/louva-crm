#!/usr/bin/env bash
# Dựng máy chủ Louva CRM từ một VPS Ubuntu 22.04 trắng. Chạy MỘT LẦN, bằng root.
#
#   DOMAIN=crm.louva.vn ADMIN_EMAIL=ceo@louva.vn bash provision.sh
#
# Sau proxy Cloudflare (mây cam) thì thêm CF_PROXY=1 để khôi phục IP thật của
# khách, nếu không giới hạn đăng nhập và nhật ký kiểm toán sẽ ghi IP Cloudflare.
#
# Không có DOMAIN thì script dùng chứng thư tự ký: dữ liệu vẫn được mã hoá trên
# đường truyền, nhưng trình duyệt sẽ cảnh báo và PWA không cài được như app.
#
# Script này KHÔNG chứa bí mật nào. Mọi khoá đều sinh tại chỗ trên máy chủ.
set -euo pipefail

REPO="${REPO:-https://github.com/truongnik-creator/louva-crm.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/louva/app
DATA_DIR=/var/lib/louva
ETC_DIR=/etc/louva
BACKUP_DIR=/var/backups/louva
ENV_FILE="$ETC_DIR/louva.env"
DOMAIN="${DOMAIN:-}"
CF_PROXY="${CF_PROXY:-0}"

[ "$(id -u)" -eq 0 ] || { echo "Phải chạy bằng root"; exit 1; }

echo "==> 1/9 Gói hệ thống"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates openssl ufw nginx sqlite3 ldnsutils >/dev/null 2>&1 \
  || apt-get install -y -qq curl git ca-certificates openssl ufw nginx sqlite3
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> 2/9 Người dùng và thư mục"
id louva >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/louva --shell /usr/sbin/nologin louva
mkdir -p "$APP_DIR" "$DATA_DIR/storage" "$ETC_DIR" "$BACKUP_DIR"
chown -R louva:louva /opt/louva "$DATA_DIR" "$BACKUP_DIR"
chmod 750 "$DATA_DIR" "$BACKUP_DIR"

echo "==> 3/9 Khoá mã hoá và biến môi trường"
# Khoá mã hoá ảnh, chữ ký, token Zalo. Đặt NGOÀI thư mục data theo README.
# Sinh một lần rồi không bao giờ đổi: đổi khoá là mất toàn bộ dữ liệu đã mã hoá.
if [ ! -f "$ETC_DIR/enc-key" ]; then
  openssl rand -hex 32 > "$ETC_DIR/enc-key"
  echo "    đã sinh $ETC_DIR/enc-key  <-- SAO LƯU TỆP NÀY RA NGOÀI MÁY, CẤT RIÊNG"
else
  echo "    $ETC_DIR/enc-key đã có, giữ nguyên"
fi
chown louva:louva "$ETC_DIR/enc-key"; chmod 400 "$ETC_DIR/enc-key"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENVEOF
NODE_ENV=production
PORT=4000
DATABASE_URL=file:$DATA_DIR/crm.db
STORAGE_DIR=$DATA_DIR/storage
ENCRYPTION_KEY_FILE=$ETC_DIR/enc-key
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
BACKUP_DIR=$BACKUP_DIR
BACKUP_KEEP=14
TRUST_PROXY=loopback
LOG_LEVEL=info
BUSINESS_TZ=Asia/Ho_Chi_Minh
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@louva.vn}
# Mật khẩu quản trị đầu tiên: để trống thì server tự sinh và in ra log MỘT LẦN
# (đọc bằng: journalctl -u louva-crm --no-pager | grep -A4 "Khoi dong lan dau").
# ADMIN_PASSWORD=
# Chưa đặt thì sáu tính năng AI tự tắt, nghiệp vụ vẫn chạy đủ.
# ANTHROPIC_API_KEY=
# Giao diện và API cùng origin nên KHÔNG cần CORS_ORIGIN.
# Zalo OA: khai đúng URL này trong bảng điều khiển Zalo khi kết nối OA.
${DOMAIN:+ZALO_OAUTH_REDIRECT_URI=https://$DOMAIN/api/zalo/oauth/callback}
# Pancake webhook trỏ về: https://${DOMAIN:-<ten-mien>}/api/pancake/webhook
# PANCAKE_WEBHOOK_SECRET=
ENVEOF
  echo "    đã sinh $ENV_FILE (JWT_SECRET ngẫu nhiên 64 ký tự)"
else
  echo "    $ENV_FILE đã có, giữ nguyên"
fi
chown root:louva "$ENV_FILE"; chmod 640 "$ENV_FILE"

echo "==> 4/9 Lấy mã nguồn"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" -q && git -C "$APP_DIR" reset --hard "origin/$BRANCH" -q
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$APP_DIR" -q
fi
chown -R louva:louva "$APP_DIR"
echo "    $(git -C "$APP_DIR" log --oneline -1)"

echo "==> 5/9 Build backend và bản web"
cd "$APP_DIR/backend" && npm ci --no-audit --no-fund -q && npm run build -q
cd "$APP_DIR/desktop" && npm ci --no-audit --no-fund -q \
  && npx vite build --config vite.web.config.mts
# Backend tự phục vụ bản web từ desktop/out/web -> cùng origin với API,
# không cần CORS, socket tự lên wss://.
test -f "$APP_DIR/desktop/out/web/index.html" || { echo "Build web thất bại"; exit 1; }
chown -R louva:louva "$APP_DIR"

echo "==> 6/9 systemd"
install -m 644 "$APP_DIR/deploy/louva-crm.service" /etc/systemd/system/louva-crm.service
systemctl daemon-reload
systemctl enable louva-crm -q
systemctl restart louva-crm
sleep 4
systemctl is-active --quiet louva-crm || { journalctl -u louva-crm -n 40 --no-pager; exit 1; }
curl -fsS http://127.0.0.1:4000/health && echo "" || { echo "backend không trả lời /health"; exit 1; }
echo "    louva-crm đang chạy"

echo "==> 7/9 nginx + TLS"
if [ -n "$DOMAIN" ]; then
  SERVER_NAME="$DOMAIN"
else
  SERVER_NAME="$(curl -fsS4 https://ifconfig.me || echo _)"
fi
sed "s/__SERVER_NAME__/$SERVER_NAME/g" "$APP_DIR/deploy/nginx-louva.conf.template" > /etc/nginx/sites-available/louva
ln -sf /etc/nginx/sites-available/louva /etc/nginx/sites-enabled/louva
rm -f /etc/nginx/sites-enabled/default

if [ -n "$DOMAIN" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx
  # Tạm phục vụ HTTP để certbot xác thực, sau đó nó tự sửa file thành 443 + redirect.
  sed -i 's/__TLS_BLOCK__//' /etc/nginx/sites-available/louva
  nginx -t && systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    -m "${ADMIN_EMAIL:-admin@$DOMAIN}" --redirect
  echo "    TLS Let's Encrypt cho $DOMAIN, tự gia hạn qua certbot.timer"
else
  mkdir -p /etc/nginx/tls
  if [ ! -f /etc/nginx/tls/louva.crt ]; then
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout /etc/nginx/tls/louva.key -out /etc/nginx/tls/louva.crt \
      -subj "/CN=$SERVER_NAME" >/dev/null 2>&1
    chmod 600 /etc/nginx/tls/louva.key
  fi
  sed -i 's|__TLS_BLOCK__|listen 443 ssl http2;\n    ssl_certificate /etc/nginx/tls/louva.crt;\n    ssl_certificate_key /etc/nginx/tls/louva.key;|' \
    /etc/nginx/sites-available/louva
  nginx -t && systemctl reload nginx
  echo "    TLS TỰ KÝ — trình duyệt sẽ cảnh báo, PWA không cài được như app."
  echo "    Trỏ một tên miền về $SERVER_NAME rồi chạy lại với DOMAIN=... để có TLS thật."
fi

if [ "$CF_PROXY" = "1" ]; then
  echo "    proxy Cloudflare: nạp dải IP để lấy IP thật từ CF-Connecting-IP"
  bash "$APP_DIR/deploy/cloudflare-realip.sh"
  cat > /etc/cron.d/louva-cf-realip <<CFCRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * 1 root bash $APP_DIR/deploy/cloudflare-realip.sh >> /var/log/louva-cf-realip.log 2>&1
CFCRON
  chmod 644 /etc/cron.d/louva-cf-realip
  echo "    cron nạp lại dải IP Cloudflare mỗi thứ Hai 4:17"
fi

echo "==> 8/9 Tường lửa"
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw deny 4000/tcp >/dev/null   # backend chỉ nghe qua nginx, không mở ra ngoài
ufw --force enable >/dev/null
echo "    mở 22, 80, 443; chặn 4000 từ ngoài"

echo "==> 9/9 Sao lưu hằng ngày 2 giờ sáng"
cat > /etc/cron.d/louva-backup <<CRONEOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 2 * * * louva cd $APP_DIR/backend && /usr/bin/npx tsx scripts/backup.ts -- --no-key >> $BACKUP_DIR/backup.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/louva-backup
echo "    --no-key: khoá mã hoá KHÔNG nằm trong bản sao lưu, phải cất riêng"

cat <<DONE

===========================================================================
 XONG. Mở: https://$SERVER_NAME
===========================================================================
 Mật khẩu quản trị đầu tiên (in ra một lần):
   journalctl -u louva-crm --no-pager | grep -A4 "Khoi dong lan dau\|Khởi động lần đầu"

 CÒN PHẢI LÀM BẰNG TAY:
 1. Sao lưu $ETC_DIR/enc-key ra NGOÀI máy chủ, cất khác chỗ bản sao lưu CSDL.
    Mất tệp này là mất toàn bộ ảnh, chữ ký, token Zalo. Không khôi phục được.
 2. Đổi mật khẩu root SSH và tắt đăng nhập bằng mật khẩu:
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
    systemctl restart ssh
 3. Chép bản sao lưu ở $BACKUP_DIR ra ổ ngoài hoặc lưu trữ ngoài máy.
 4. Chưa seed dữ liệu nào: phòng khám, dịch vụ, bảng giá nhập trong Cài đặt.
    Muốn nạp danh mục NOVA (29 dịch vụ, bảng giá, mẫu tin), KHÔNG tạo khách
    demo:  cd $APP_DIR/backend && sudo -u louva npx tsx prisma/seed.ts
===========================================================================
DONE
