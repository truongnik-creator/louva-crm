import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Chạy renderer như một WEB APP thuần trong trình duyệt (không cần Electron).
// Dùng để phát triển/kiểm thử nhanh, và là bước đệm sang kiến trúc web app
// nêu ở mục 2.1 tài liệu kiến trúc. Vỏ Electron vẫn dùng electron.vite.config.ts.

/** F28: gắn manifest, màu thanh trạng thái, biểu tượng iOS vào index.html CHỈ ở bản web. */
function pwaHead(): Plugin {
  return {
    name: 'louva-pwa-head',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        [
          '    <link rel="manifest" href="/manifest.webmanifest" />',
          '    <meta name="theme-color" content="#0f5132" />',
          '    <meta name="mobile-web-app-capable" content="yes" />',
          '    <meta name="apple-mobile-web-app-capable" content="yes" />',
          '    <meta name="apple-mobile-web-app-title" content="Louva CRM" />',
          '    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
          '    <link rel="icon" type="image/png" href="/icons/icon-192.png" />',
          '  </head>'
        ].join('\n')
      )
    }
  }
}

export default defineConfig({
  root: 'src/renderer',
  // F28: manifest, biểu tượng, service worker nằm riêng ở public-web để bản
  // Electron (electron.vite.config.ts, publicDir mặc định) không mang theo.
  publicDir: 'public-web',
  plugins: [react(), pwaHead()],
  server: {
    port: 5173,
    strictPort: true,
    // Chạy dev ở 5173 thì chuyển /api và socket sang backend cổng 4000 (cùng origin như bản build).
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true }
    }
  },
  build: { outDir: '../../out/web', emptyOutDir: true },
  define: {
    // Bản web do chính backend phục vụ nên API nằm CÙNG ORIGIN. Đường dẫn
    // tương đối giúp cùng một bản build chạy được ở localhost, LAN, hay sau
    // Cloudflare Tunnel mà không phải build lại theo từng tên miền.
    'import.meta.env.VITE_API_URL': JSON.stringify('/api'),
    'import.meta.env.VITE_PWA': JSON.stringify('1')
  }
})
