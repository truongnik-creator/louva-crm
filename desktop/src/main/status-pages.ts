/**
 * Tiny self-contained HTML pages shown inside the main BrowserWindow while
 * the bundled backend is starting up (or failed to start), before the real
 * React renderer is loaded. Kept as inline data: URLs so no extra build
 * step / vite entry is needed for what is effectively a splash screen.
 */

function shell(bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: #0f172a;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    text-align: center;
    max-width: 420px;
    padding: 24px;
  }
  h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  p {
    font-size: 13px;
    color: #94a3b8;
    line-height: 1.5;
    margin: 0;
  }
  .spinner {
    width: 28px;
    height: 28px;
    margin: 0 auto 16px;
    border-radius: 50%;
    border: 3px solid rgba(148, 163, 184, 0.25);
    border-top-color: #60a5fa;
    animation: spin 0.8s linear infinite;
  }
  .error-icon {
    font-size: 28px;
    margin-bottom: 12px;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
</body>
</html>`
}

export function loadingPageUrl(): string {
  const html = shell(
    `<div class="spinner"></div><h1>Đang khởi động CRM…</h1><p>Đang chuẩn bị dữ liệu, vui lòng đợi trong giây lát.</p>`
  )
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export function errorPageUrl(message: string): string {
  const html = shell(
    `<div class="error-icon">⚠️</div><h1>Không thể khởi động dịch vụ nền</h1><p>${escapeHtml(message)}</p>`
  )
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
