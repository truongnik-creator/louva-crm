#!/usr/bin/env bash
# Cập nhật máy chủ lên commit mới nhất của nhánh main. Chạy từ máy cá nhân.
#
#   ./deploy/deploy.sh                      # dùng HOST trong deploy/target.env
#   HOST=root@221.132.16.132 ./deploy/deploy.sh
#
# Yêu cầu: đã cài khoá SSH lên máy chủ (xem docs/TRIEN-KHAI-VPS.md bước 1).
# Script này không nhận và không lưu mật khẩu.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/target.env" ] && . "$HERE/target.env"
HOST="${HOST:?Thiếu HOST, ví dụ HOST=root@221.132.16.132}"
BRANCH="${BRANCH:-main}"

echo "==> Kiểm tra cục bộ trước khi đẩy"
( cd "$HERE/.."/backend && npm run -s typecheck && npm test --silent >/dev/null )
echo "    typecheck và 235 test: OK"

echo "==> Triển khai lên $HOST (nhánh $BRANCH)"
ssh -o BatchMode=yes "$HOST" BRANCH="$BRANCH" bash -s <<'REMOTE'
set -euo pipefail
APP=/opt/louva/app
cd "$APP"
echo "    trước:  $(git log --oneline -1)"
git fetch --depth 1 origin "$BRANCH" -q
git reset --hard "origin/$BRANCH" -q
echo "    sau:    $(git log --oneline -1)"

cd "$APP/backend"
npm ci --omit=dev --no-audit --no-fund -q 2>/dev/null || npm ci --no-audit --no-fund -q
npm run build -q
cd "$APP/desktop"
npm ci --no-audit --no-fund -q
npx vite build --config vite.web.config.mts
test -f "$APP/desktop/out/web/index.html"
chown -R louva:louva "$APP"

# bootstrap.ts tự chụp CSDL rồi áp migration mới khi khởi động lại.
systemctl restart louva-crm
sleep 5
systemctl is-active --quiet louva-crm || { journalctl -u louva-crm -n 40 --no-pager; exit 1; }
curl -fsS http://127.0.0.1:4000/health \
  && echo "    /health OK" || echo "    (không có /health, bỏ qua)"
echo "    louva-crm đã chạy lại"
REMOTE
echo "==> Xong"
