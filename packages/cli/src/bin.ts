#!/usr/bin/env node
import { hookDeadlineMs, main } from './cli.js'

const argv = process.argv.slice(2)
const isHook = argv[0] === 'hook'

// Hooks never block coding: a hard exit 0 just after the hook's own deadline, whatever is still pending.
const deadline = hookDeadlineMs(argv)
if (deadline !== undefined) setTimeout(() => process.exit(0), deadline + 1000).unref()

function finish(code: number): void {
  // Exit explicitly so idle keep-alive sockets or a timed-out request never hold a hook open.
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

main(argv, {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
}).then(finish, (e) => {
  // Only reachable for non-hook commands; hooks swallow everything.
  if (!isHook) process.stderr.write(`spoor: ${e instanceof Error ? e.message : String(e)}\n`)
  finish(isHook ? 0 : 1)
})
