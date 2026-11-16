import { describe, expect, it } from 'vitest'
import { settingsJsonBlock } from './install.js'

const values = { server: 'https://spoor.example.com', slug: 'acme', version: '0.7.5' }

describe('settingsJsonBlock', () => {
  it('names UserPromptSubmit only when recall is decided: the hook when on, no entry when off', () => {
    const plain = settingsJsonBlock(values).hooks as Record<string, unknown>
    expect(Object.keys(plain).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop'])
    const on = settingsJsonBlock(values, { recall: true }).hooks as Record<string, unknown>
    expect(on.UserPromptSubmit).toEqual([
      {
        hooks: [
          {
            type: 'command',
            timeout: 5,
            command: 'command -v spoor >/dev/null 2>&1 && exec spoor hook user-prompt-submit || exit 0',
          },
        ],
      },
    ])
    expect(
      (settingsJsonBlock(values, { recall: false }).hooks as Record<string, unknown>).UserPromptSubmit,
    ).toEqual([])
  })
})
