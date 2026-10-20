/** Which spaces only humans write (ADR-0014): agents read them, never change them. */
import type { Space } from './frontmatter.js'

/** Spaces whose writes need a web session of a user holding the right (`library.write`). */
export const HUMAN_ONLY_SPACES = ['library'] as const satisfies readonly Space[]

export const isHumanOnlySpace = (s: Space): boolean => (HUMAN_ONLY_SPACES as readonly Space[]).includes(s)
