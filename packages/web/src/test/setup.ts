import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Lazy routes import their page module on first render; under a loaded parallel run that import alone can
// take longer than the default 1 s of findBy*/waitFor.
configure({ asyncUtilTimeout: 5_000 })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
