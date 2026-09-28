/* Cầu nối tới tiến trình chính của Electron.
 *
 * Tài liệu kiến trúc (mục 2.1) chốt hướng đi là WEB APP, còn Electron chỉ còn
 * là vỏ mỏng cho máy quầy lễ tân. Vì vậy renderer không được phụ thuộc cứng vào
 * `window.crm`: khi chạy trong trình duyệt thường (hoặc PWA trên iPad), ta rơi
 * về localStorage với đúng bộ hàm đó.
 *
 * Gọi installBridgeFallback() một lần ở main.tsx, trước khi React khởi động.
 */

interface CrmBridgeShape {
  openExternal: (url: string) => Promise<void>
  getTokens: () => Promise<{ accessToken: string | null; refreshToken: string | null }>
  setTokens: (accessToken: string | null, refreshToken: string | null) => Promise<void>
  getBranch: () => Promise<string | null>
  setBranch: (branchId: string | null) => Promise<void>
  getAppVersion: () => Promise<string>
  getBackendStatus: () => Promise<string>
}

const KEYS = {
  access: 'crm.accessToken',
  refresh: 'crm.refreshToken',
  branch: 'crm.branchId'
}

const browserBridge: CrmBridgeShape = {
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  async getTokens() {
    return {
      accessToken: localStorage.getItem(KEYS.access),
      refreshToken: localStorage.getItem(KEYS.refresh)
    }
  },
  async setTokens(accessToken, refreshToken) {
    if (accessToken) localStorage.setItem(KEYS.access, accessToken)
    else localStorage.removeItem(KEYS.access)
    if (refreshToken) localStorage.setItem(KEYS.refresh, refreshToken)
    else localStorage.removeItem(KEYS.refresh)
  },
  async getBranch() {
    return localStorage.getItem(KEYS.branch)
  },
  async setBranch(branchId) {
    if (branchId) localStorage.setItem(KEYS.branch, branchId)
    else localStorage.removeItem(KEYS.branch)
  },
  async getAppVersion() {
    return 'web'
  },
  async getBackendStatus() {
    // Ngoài Electron thì không có tiến trình backend do app tự quản — coi như
    // đã sẵn sàng, lỗi kết nối thật sẽ hiện ra khi gọi API.
    return 'ready'
  }
}

export function installBridgeFallback(): void {
  if (!window.crm) {
    ;(window as unknown as { crm: CrmBridgeShape }).crm = browserBridge
  }
}
