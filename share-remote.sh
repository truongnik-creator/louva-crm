#!/usr/bin/env bash
#
# Mở phần mềm ra Internet qua Cloudflare Tunnel.
#
#   ./share-remote.sh          bật (build web + chạy backend + mở tunnel)
#   ./share-remote.sh stop     tắt tunnel và backend
#   ./share-remote.sh url      in lại link đang chạy
#
# Backend phục vụ luôn giao diện web nên chỉ cần MỘT đường hầm vào cổng 4000.
#
# LƯU Ý: đây là "quick tunnel" — không cần tài khoản Cloudflare, nhưng link ĐỔI
# mỗi lần khởi động lại và chỉ sống khi máy này còn bật, còn mạng, không ngủ.
# Muốn link cố định thì phải đăng nhập Cloudflare và tạo named tunnel (xem README).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
DESKTOP="$ROOT/desktop"
CLOUDFLARED="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
PORT="${PORT:-4000}"

LOG_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
URL_FILE="$LOG_DIR/url.txt"

stop_all() {
  pkill -f "tsx src/index.ts" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  pkill -f "caffeinate -dimsu -w" 2>/dev/null || true
  rm -f "$URL_FILE"
  echo "Đã tắt backend và tunnel."
}

case "${1:-start}" in
  stop)
    stop_all
    exit 0
    ;;
  url)
    if [ -f "$URL_FILE" ]; then cat "$URL_FILE"; else echo "Chưa có tunnel nào đang chạy."; fi
    exit 0
    ;;
esac

if [ ! -x "$CLOUDFLARED" ]; then
  echo "Không tìm thấy cloudflared tại $CLOUDFLARED"
  echo "Cài bằng:"
  echo "  curl -sL -o /tmp/cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
  echo "  tar xzf /tmp/cf.tgz -C /tmp && mkdir -p ~/.local/bin && mv /tmp/cloudflared ~/.local/bin/ && chmod +x ~/.local/bin/cloudflared"
  exit 1
fi

stop_all >/dev/null 2>&1 || true

echo "1/4  Build giao diện web…"
(cd "$DESKTOP" && npx vite build --config vite.web.config.mts >/dev/null 2>&1)

echo "2/4  Khởi động máy chủ (cổng $PORT)…"
(cd "$BACKEND" && PORT="$PORT" nohup npx tsx src/index.ts > "$BACKEND_LOG" 2>&1 &)

for _ in $(seq 1 30); do
  sleep 1
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
done
if ! curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "Máy chủ không lên được. Xem log: $BACKEND_LOG"
  exit 1
fi

echo "3/4  Mở đường hầm Cloudflare…"
# --protocol http2 --edge-ip-version 4: mặc định QUIC/IPv6 hay bị rớt hoặc
# đăng ký hụt ở mạng Việt Nam, biểu hiện là có link nhưng gọi vào trả HTTP 000.
nohup "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" --no-autoupdate \
  --protocol http2 --edge-ip-version 4 > "$TUNNEL_LOG" 2>&1 &

URL=""
for _ in $(seq 1 30); do
  sleep 2
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  [ -n "$URL" ] && break
done

if [ -z "$URL" ]; then
  echo "Không lấy được link. Xem log: $TUNNEL_LOG"
  exit 1
fi

echo "$URL" > "$URL_FILE"

# Giữ máy không ngủ chừng nào tunnel còn chạy — máy ngủ là link chết.
TUNNEL_PID=$(pgrep -f "cloudflared tunnel --url" | head -1)
nohup caffeinate -dimsu -w "$TUNNEL_PID" >/dev/null 2>&1 &

echo "4/4  Kiểm tra từ ngoài…"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$URL/health")

echo
echo "======================================================================"
echo "  LINK TRUY CẬP TỪ XA:  $URL"
echo "  Kiểm tra máy chủ:     HTTP $CODE"
echo "======================================================================"
echo
echo "  Tắt đi:      ./share-remote.sh stop"
echo "  Xem lại link: ./share-remote.sh url"
echo "  Log:         $BACKEND_LOG · $TUNNEL_LOG"
echo
echo "  CẢNH BÁO: link công khai, ai có link đều vào được. Đổi mật khẩu"
echo "  mặc định trước khi gửi cho người khác."
echo
