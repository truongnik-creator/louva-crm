import type { CrmBridge } from './index'

declare global {
  interface Window {
    crm: CrmBridge
  }
}
