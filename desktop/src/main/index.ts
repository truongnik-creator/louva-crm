import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import { join } from 'path'
import { is } from './is'
import Store from 'electron-store'
import { ensureBackendRunning, stopBackend, BackendStatus } from './backend-process'
import { loadingPageUrl, errorPageUrl } from './status-pages'

// Access token sống 15 phút, refresh token 7 ngày — phải lưu cả hai thì mở
// lại app mới không bắt đăng nhập lại (xem lib/api.ts phía renderer).
interface StoreSchema {
  accessToken: string | null
  refreshToken: string | null
  branchId: string | null
}

const store = new Store<StoreSchema>({
  name: 'crm-auth',
  defaults: { accessToken: null, refreshToken: null, branchId: null }
})

/*
 * T5: token KHÔNG lưu dạng rõ trong tệp JSON của electron-store nữa. Mã hoá
 * bằng safeStorage (Keychain trên macOS, DPAPI trên Windows, libsecret trên
 * Linux) rồi lưu base64 kèm tiền tố "enc:". Máy không có kho khoá hệ điều
 * hành (Linux thiếu libsecret) thì KHÔNG lưu token: người dùng đăng nhập lại
 * mỗi lần mở app, còn hơn để refresh token 7 ngày nằm trần trên đĩa.
 */
const ENC_PREFIX = 'enc:'

function sealToken(value: string | null): string | null {
  if (!value) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function openToken(stored: string | null): string | null {
  if (!stored) return null
  if (!stored.startsWith(ENC_PREFIX)) return null // bản rõ cũ: bỏ, bắt đăng nhập lại
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return null
  }
}

/** Chỉ cho mở ra ngoài các liên kết http/https (chặn file:, javascript:, smb:...). */
function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

let currentBackendStatus: BackendStatus = 'checking'

function loadApp(mainWindow: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // T5: preload chỉ dùng contextBridge + ipcRenderer nên chạy được trong sandbox.
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Không cho cửa sổ app bị điều hướng sang trang lạ (link độc trong tin nhắn
  // khách, chuyển hướng...). Trang ngoài luôn mở bằng trình duyệt hệ thống.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL()
    let sameOrigin = false
    try {
      sameOrigin = new URL(url).origin === new URL(current).origin
    } catch {
      sameOrigin = false
    }
    if (!sameOrigin && !url.startsWith('data:') && !url.startsWith('file:')) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })

  // Show a lightweight loading state immediately; swapped for the real
  // renderer (or an error page) once the backend health check settles.
  mainWindow.loadURL(loadingPageUrl())

  return mainWindow
}

async function startBackendAndLoadWindow(mainWindow: BrowserWindow): Promise<void> {
  const result = await ensureBackendRunning((status) => {
    currentBackendStatus = status
  })

  if (mainWindow.isDestroyed()) return

  if (result.ok) {
    console.log(
      result.usingExisting
        ? '[backend] reusing already-running backend instance'
        : '[backend] backend is healthy, loading app'
    )
    loadApp(mainWindow)
    return
  }

  currentBackendStatus = 'error'
  const message =
    'Không thể kết nối tới dịch vụ nền (backend) sau nhiều lần thử. Vui lòng khởi động lại ứng dụng.'
  mainWindow.loadURL(errorPageUrl(message))
  dialog.showErrorBox('Louva CRM — Lỗi khởi động', message)
}

ipcMain.handle('open-external', async (_event, url: string) => {
  if (typeof url === 'string' && isSafeExternalUrl(url)) {
    await shell.openExternal(url)
  }
})

ipcMain.handle('auth:get-tokens', () => {
  return {
    accessToken: openToken(store.get('accessToken')),
    refreshToken: openToken(store.get('refreshToken'))
  }
})

ipcMain.handle(
  'auth:set-tokens',
  (_event, accessToken: string | null, refreshToken: string | null) => {
    store.set('accessToken', sealToken(typeof accessToken === 'string' ? accessToken : null))
    store.set('refreshToken', sealToken(typeof refreshToken === 'string' ? refreshToken : null))
  }
)

ipcMain.handle('auth:get-branch', () => {
  return store.get('branchId')
})

ipcMain.handle('auth:set-branch', (_event, branchId: string | null) => {
  store.set('branchId', branchId)
})

ipcMain.handle('app:get-version', () => {
  return app.getVersion()
})

ipcMain.handle('backend:get-status', () => {
  return currentBackendStatus
})

app.whenReady().then(() => {
  const mainWindow = createWindow()
  void startBackendAndLoadWindow(mainWindow)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      void startBackendAndLoadWindow(win)
    }
  })
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopBackend()
})
