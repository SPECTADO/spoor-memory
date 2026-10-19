/**
 * Hook entry points: always exit 0, never block. SPOOR_DRAFTING=1 (set on the drafting child, D2)
 * and SPOOR_DISABLE=1 make every hook a no-op before any work happens.
 */
export function hookDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SPOOR_DRAFTING === '1' || env.SPOOR_DISABLE === '1'
}

export async function runHook(
  fn: () => Promise<void> | void,
  env: NodeJS.ProcessEnv = process.env,
  onError: (e: unknown) => void = () => {},
): Promise<0> {
  if (hookDisabled(env)) return 0
  try {
    await fn()
  } catch (e) {
    try {
      onError(e)
    } catch {
      // never throw from a hook
    }
  }
  return 0
}
