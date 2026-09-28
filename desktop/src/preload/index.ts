import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  getTokens: (): Promise<{ accessToken: string | null; refreshToken: string | null }> =>
    ipcRenderer.invoke('auth:get-tokens'),
  setTokens: (accessToken: string | null, refreshToken: string | null): Promise<void> =>
    ipcRenderer.invoke('auth:set-tokens', accessToken, refreshToken),
  getBranch: (): Promise<string | null> => ipcRenderer.invoke('auth:get-branch'),
  setBranch: (branchId: string | null): Promise<void> => ipcRenderer.invoke('auth:set-branch', branchId),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getBackendStatus: (): Promise<string> => ipcRenderer.invoke('backend:get-status')
}

export type CrmBridge = typeof api

// contextIsolation is always enabled for this app (see src/main/index.ts
// webPreferences), so the API is exposed exclusively via contextBridge.
try {
  contextBridge.exposeInMainWorld('crm', api)
} catch (error) {
  console.error(error)
}
