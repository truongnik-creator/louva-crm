import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Chạy renderer như một WEB APP thuần trong trình duyệt (không cần Electron).
// Dùng để phát triển/kiểm thử nhanh, và là bước đệm sang kiến trúc web app
// nêu ở mục 2.1 tài liệu kiến trúc. Vỏ Electron vẫn dùng electron.vite.config.ts.
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../out/web', emptyOutDir: true },
  define: {
    // Bản web do chính backend phục vụ nên API nằm CÙNG ORIGIN. Đường dẫn
    // tương đối giúp cùng một bản build chạy được ở localhost, LAN, hay sau
    // Cloudflare Tunnel mà không phải build lại theo từng tên miền.
    'import.meta.env.VITE_API_URL': JSON.stringify('/api')
  }
})
