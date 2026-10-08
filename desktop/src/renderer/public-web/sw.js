/* F28: SERVICE WORKER TỐI THIỂU cho bản web.
 *
 * Chỉ lưu đệm KHUNG ỨNG DỤNG (trang gốc, manifest, biểu tượng, tệp JS/CSS đã
 * build trong /assets/). KHÔNG BAO GIỜ lưu đệm phản hồi /api (dữ liệu khách,
 * ảnh, SĐT) hay /socket.io: các yêu cầu đó đi thẳng ra mạng, service worker
 * không chạm vào. Mất mạng thì app mở được khung, dữ liệu báo lỗi như web thường.
 */
const CACHE = 'louva-shell-v1'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

/** Đường dẫn không bao giờ lưu đệm (dữ liệu nghiệp vụ, thời gian thực). */
const NEVER_CACHE = ['/api/', '/socket.io/']

function isNeverCache(pathname) {
  return NEVER_CACHE.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p))
}

/** Chỉ tệp khung ứng dụng cùng nguồn mới được lưu. */
function isShellAsset(url) {
  if (url.origin !== self.location.origin) return false
  if (isNeverCache(url.pathname)) return false
  return APP_SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Dữ liệu nghiệp vụ: để trình duyệt tự đi mạng, không lưu, không trả bản cũ.
  if (isNeverCache(url.pathname) || url.origin !== self.location.origin) return

  // Mở trang: ưu tiên mạng (bản mới nhất), mất mạng thì trả khung đã lưu.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))))
    return
  }

  if (!isShellAsset(url)) return
  // Tệp khung: có sẵn thì dùng ngay, đồng thời tải bản mới về lưu.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok && res.type === 'basic') cache.put(req, res.clone())
            return res
          })
          .catch(() => cached)
        return cached || network
      })
    )
  )
})
