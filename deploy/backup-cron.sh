#!/usr/bin/env bash
# Sao lưu hằng đêm. Gọi từ /etc/cron.d/louva-backup.
#
# Vì sao cần wrapper thay vì gọi thẳng scripts/backup.ts trong cron: cron không
# nạp /etc/louva/louva.env, và khi thiếu env thì app KHÔNG báo lỗi — nó lặng lẽ
# rơi về mặc định phát triển, sinh khoá mã hoá mới, rồi sao lưu một CSDL RỖNG ở
# backend/data vào backend/backups và báo "thành công". Mỗi đêm một bản sao lưu
# vô dụng, không ai biết. Wrapper này nạp env rồi KIỂM TRA trước khi chạy.
set -euo pipefail

ENV_FILE=/etc/louva/louva.env
APP=/opt/louva/app/backend

[ -r "$ENV_FILE" ] || { echo "[$(date -Is)] không đọc được $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

# Ba điều kiện này sai là bản sao lưu vô giá trị — dừng hẳn, đừng tạo rác.
[ "${NODE_ENV:-}" = "production" ] || { echo "[$(date -Is)] NODE_ENV không phải production"; exit 1; }
case "${DATABASE_URL:-}" in
  file:/var/lib/louva/*) ;;
  *) echo "[$(date -Is)] DATABASE_URL không trỏ /var/lib/louva: ${DATABASE_URL:-trống}"; exit 1 ;;
esac
[ -s "${ENCRYPTION_KEY_FILE:-/nonexistent}" ] || { echo "[$(date -Is)] thiếu ENCRYPTION_KEY_FILE"; exit 1; }

cd "$APP"
# --no-key: khoá mã hoá KHÔNG nằm trong bản sao lưu, phải cất riêng ngoài máy.
exec /usr/bin/npx tsx scripts/backup.ts -- --no-key
