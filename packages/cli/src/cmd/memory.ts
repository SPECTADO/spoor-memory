/** `spoor memory sync` (cli-and-hooks.md section 4.11, ADR-0036): the two-way sync of local memory files, by hand. */
import type { Ctx } from '../ctx.js'
import { syncLocalMemory } from '../local-memory.js'
import { localMemoryFiles } from '../mirror.js'
import { readState } from '../state.js'

export async function cmdMemorySync(
  ctx: Ctx,
  o: { takeServer?: boolean; takeLocal?: boolean },
): Promise<number> {
  const rt = ctx.rt
  if (o.takeServer && o.takeLocal) {
    rt.err('spoor: --take-server and --take-local exclude each other\n')
    return 1
  }
  const mode = ctx.repo.local_memory.mode
  if (mode !== 'sync') {
    rt.err(
      mode === 'delete'
        ? 'spoor: this project deletes local memory files after importing them (local_memory.mode: delete); run spoor init\n'
        : 'spoor: local memory files are not synced in this project; choose with spoor init --local-memory sync (or delete)\n',
    )
    return 1
  }
  if (localMemoryFiles(ctx).length === 0) {
    rt.out('no local memory files\n')
    return 0
  }
  if (o.takeLocal) {
    const conflicts = readState(ctx.root).conflicts.map((c) => c.path)
    if (conflicts.length > 0) {
      if (!rt.isTTY) {
        rt.err('spoor: --take-local needs an interactive terminal and a typed confirmation\n')
        return 1
      }
      const answer = await rt.prompt(
        `Overwrite Spoor with the local text of ${conflicts.join(', ')}? Type y to confirm: `,
      )
      if (answer.trim().toLowerCase() !== 'y') {
        rt.err('spoor: not confirmed; nothing was pushed\n')
        return 2
      }
    }
  }
  return syncLocalMemory(ctx, o)
}
