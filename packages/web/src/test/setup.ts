import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Lazy routes import their page module on first render; under a loaded parallel run that import alone can
// take longer than the default 1 s of findBy*/waitFor.
configure({ asyncUtilTimeout: 5_000 })

// Node 25+ has its own Web Storage globals. Without --localstorage-file the native `localStorage` getter
// gives undefined, and because the key already exists on globalThis vitest does not copy jsdom's Storage
// over it. Put jsdom's Storage back so code under test sees a real localStorage/sessionStorage.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (globalThis[key] === undefined) {
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
    }
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
