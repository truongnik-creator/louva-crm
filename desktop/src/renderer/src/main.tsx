import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './lib/auth-context'
import { ToastProvider } from './components/ui'
import { installBridgeFallback } from './lib/bridge'
import './styles/theme.css'

// Chạy được cả trong Electron lẫn trình duyệt thường — xem lib/bridge.ts.
installBridgeFallback()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </HashRouter>
  </React.StrictMode>
)
