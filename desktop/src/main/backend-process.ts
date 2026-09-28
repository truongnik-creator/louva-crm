import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import http from 'http'
import Store from 'electron-store'
import { is } from './is'

/**
 * Owns the lifecycle of the CRM backend (Node/Express/Prisma API) as a child
 * process of the Electron main process, so the desktop app is fully
 * self-contained: `npm run dev` (or launching the packaged app) is the only
 * thing a user ever has to run.
 */

export type BackendStatus = 'checking' | 'starting' | 'ready' | 'error' | 'external'

// Single source of truth for the backend port. Matches the backend's own
// default (src/lib/env.ts -> PORT ?? 4000) and the renderer's API base URL
// fallback (src/renderer/src/lib/api.ts) and desktop/.env's VITE_API_URL.
export const BACKEND_PORT = Number(process.env.CRM_BACKEND_PORT) || 4000
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`
const HEALTH_URL = `${BACKEND_URL}/health`

let backendProcess: ChildProcess | null = null
let backendIsExternal = false

interface SecretStoreSchema {
  jwtSecret: string
}

// Persisted locally so the backend's JWT signing secret is stable across
// restarts even though the backend itself ships with no .env file.
const secretStore = new Store<SecretStoreSchema>({
  name: 'crm-backend-secret',
  defaults: { jwtSecret: '' }
})

function getOrCreateJwtSecret(): string {
  let secret = secretStore.get('jwtSecret')
  if (!secret) {
    secret = randomBytes(48).toString('hex')
    secretStore.set('jwtSecret', secret)
  }
  return secret
}

/** Directory that contains the backend's package.json / dist / prisma folder. */
function resolveBackendDir(): string {
  if (app.isPackaged) {
    // Bundled via electron-builder's extraResources (see electron-builder.yml).
    return join(process.resourcesPath, 'backend')
  }
  // Dev: compiled main process lives at desktop/out/main/index.js, so walk
  // up to the desktop package root, then over to the sibling backend package.
  return join(__dirname, '../../../backend')
}

/**
 * Resolves the compiled backend entrypoint. The contract is `dist/index.js`,
 * but while the backend is mid-migration its build still emits
 * `dist/src/index.js` (rootDir includes prisma/ + src/), so fall back to
 * that legacy layout rather than hard failing.
 */
function resolveBackendEntry(backendDir: string): string {
  const standard = join(backendDir, 'dist', 'index.js')
  if (existsSync(standard)) return standard

  const legacy = join(backendDir, 'dist', 'src', 'index.js')
  if (existsSync(legacy)) return legacy

  throw new Error(
    `Backend build not found in ${backendDir}. Expected dist/index.js (run "npm install && npm run build" in backend/).`
  )
}

function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 1500 }, (res) => {
      res.resume()
      resolve(!!res.statusCode && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    if (await checkHealth()) return true
    await delay(intervalMs)
  } while (Date.now() < deadline)
  return false
}

/**
 * Ensures a healthy backend is reachable at BACKEND_URL, spawning one if
 * necessary. Safe to call even if a backend is already running (e.g. a
 * previous instance that didn't clean up, or a developer running the
 * backend manually) — in that case it just adopts the existing instance
 * instead of trying to bind the port a second time.
 */
export async function ensureBackendRunning(
  onStatus?: (status: BackendStatus) => void
): Promise<{ ok: boolean; usingExisting: boolean }> {
  onStatus?.('checking')

  if (await checkHealth()) {
    backendIsExternal = true
    onStatus?.('external')
    return { ok: true, usingExisting: true }
  }

  const backendDir = resolveBackendDir()
  let entry: string
  try {
    entry = resolveBackendEntry(backendDir)
  } catch (error) {
    console.error('[backend]', error)
    onStatus?.('error')
    return { ok: false, usingExisting: false }
  }

  onStatus?.('starting')

  // SQLite file lives under Electron's userData dir in BOTH dev and prod —
  // this is always writable (unlike a packaged app's read-only resources
  // dir) and keeps a single code path instead of branching per environment.
  const dbPath = join(app.getPath('userData'), 'crm.db')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(BACKEND_PORT),
    NODE_ENV: is.dev ? 'development' : 'production',
    DATABASE_URL: process.env.CRM_DATABASE_URL ?? `file:${dbPath}`,
    JWT_SECRET: process.env.CRM_JWT_SECRET ?? getOrCreateJwtSecret(),
    CORS_ORIGIN: process.env.CRM_CORS_ORIGIN ?? '*',
    // Run the backend script under Electron's own bundled Node runtime
    // instead of requiring a system-wide `node` install or shipping a
    // separate Node runtime inside the packaged app.
    ELECTRON_RUN_AS_NODE: '1'
  }

  console.log(`[backend] spawning ${entry} (cwd=${backendDir}, port=${BACKEND_PORT})`)

  backendProcess = spawn(process.execPath, [entry], {
    cwd: backendDir,
    env,
    stdio: 'pipe'
  })
  backendIsExternal = false

  backendProcess.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[backend] ${chunk}`)
  })
  backendProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[backend:err] ${chunk}`)
  })
  backendProcess.on('exit', (code, signal) => {
    console.log(`[backend] process exited (code=${code}, signal=${signal})`)
    backendProcess = null
  })
  backendProcess.on('error', (error) => {
    console.error('[backend] failed to spawn:', error)
  })

  const healthy = await waitForHealth(15_000)
  onStatus?.(healthy ? 'ready' : 'error')
  return { ok: healthy, usingExisting: false }
}

/** Kills the backend child process if we own it. Leaves externally-managed instances alone. */
export function stopBackend(): void {
  if (backendIsExternal) return
  if (backendProcess && !backendProcess.killed) {
    console.log('[backend] stopping child process')
    backendProcess.kill()
  }
  backendProcess = null
}
