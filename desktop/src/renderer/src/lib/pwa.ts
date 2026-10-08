/* F28: đăng ký service worker cho bản web (cài như app trên điện thoại).
   VITE_PWA chỉ được định nghĩa trong vite.web.config.mts, nên bản Electron
   (electron.vite.config.ts) không bao giờ đăng ký. Service worker chỉ lưu đệm
   khung ứng dụng, không bao giờ lưu phản hồi /api (xem public-web/sw.js). */
export function registerServiceWorker(): void {
  if (import.meta.env.VITE_PWA !== '1') return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Không đăng ký được thì app vẫn chạy bình thường như web thường.
    })
  })
}
