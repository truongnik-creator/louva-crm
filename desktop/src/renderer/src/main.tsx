import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './lib/auth-context'
import { ClinicProvider } from './lib/clinic-context'
import { ToastProvider } from './components/ui'
import { installBridgeFallback } from './lib/bridge'
import './styles/theme.css'
import './styles/mobile.css'
import './styles/crm360.css'
import { registerServiceWorker } from './lib/pwa'

// Chạy được cả trong Electron lẫn trình duyệt thường — xem lib/bridge.ts.
installBridgeFallback()
// F28: chỉ bản web (vite.web.config.mts) mới đăng ký service worker; Electron không.
registerServiceWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <ToastProvider>
        <AuthProvider>
          <ClinicProvider>
            <App />
          </ClinicProvider>
        </AuthProvider>
      </ToastProvider>
    </HashRouter>
  </React.StrictMode>
)
