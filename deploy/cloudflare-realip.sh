#!/usr/bin/env bash
# Khôi phục IP thật của khách khi đứng sau proxy Cloudflare (mây cam).
#
# Vì sao bắt buộc: qua proxy, mọi yêu cầu đến nginx đều mang IP của biên
# Cloudflare. Backend có TRUST_PROXY=loopback nên chỉ tin một chặng proxy cục
# bộ, tức là nó sẽ coi IP biên Cloudflare là IP khách. Hậu quả thật:
#   - Giới hạn đăng nhập 10 lần / 15 phút mỗi IP sẽ tính gộp CẢ PHÒNG KHÁM vào
#     vài IP Cloudflare -> một người gõ sai mật khẩu vài lần là khoá cả nhà.
#   - Nhật ký kiểm toán ghi sai IP, truy vết ai xem bệnh án nào mất ý nghĩa.
#
# Script này nạp dải IP công bố của Cloudflare và khai set_real_ip_from, rồi
# lấy IP khách từ header CF-Connecting-IP.
set -euo pipefail
OUT=/etc/nginx/conf.d/cloudflare-realip.conf
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  echo "# Sinh tự động bởi deploy/cloudflare-realip.sh — $(date -Is)"
  echo "# Dải IP Cloudflare đổi theo thời gian; cron hằng tuần nạp lại."
  for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
    curl -fsS --max-time 20 "$url" | while read -r cidr; do
      [ -n "$cidr" ] && echo "set_real_ip_from $cidr;"
    done
  done
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive on;"
} > "$TMP"

# Chỉ ghi đè khi nạp được đủ dải, tránh thay file tốt bằng file rỗng lúc mạng lỗi.
if [ "$(grep -c set_real_ip_from "$TMP")" -lt 10 ]; then
  echo "Nạp dải IP Cloudflare thất bại (chỉ $(grep -c set_real_ip_from "$TMP") dải), giữ cấu hình cũ" >&2
  exit 1
fi
install -m 644 "$TMP" "$OUT"
nginx -t && systemctl reload nginx
echo "Đã cập nhật $OUT ($(grep -c set_real_ip_from "$OUT") dải)"
