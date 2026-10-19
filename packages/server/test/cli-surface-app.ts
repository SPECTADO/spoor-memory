/**
 * The app as the CLI and hooks see it: since app.ts mounts the device, install, mirror and MCP modules
 * itself, this is `testApp()` plus direct handles on those modules (kept so the module tests read the same).
 */
import { type TestAppOptions, testApp } from './http.js'

export function cliSurfaceApp(opts: TestAppOptions = {}) {
  const base = testApp(opts)
  const m = base.modules
  return { ...base, device: m.device, install: m.install, mirror: m.mirror, mcp: m.mcp }
}
