/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  /** F28: "1" chỉ ở bản web (vite.web.config.mts), dùng để đăng ký service worker. */
  readonly VITE_PWA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
