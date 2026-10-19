/**
 * Deterministic, conservative token estimator (docs/design/search-and-digest.md section 6).
 * est(s) = ceil(sum of w(cp)) with w = 1/2.2 below U+0370, 1/1.5 up to U+FFFF, 2 above.
 * Subadditive: est(a + b) <= est(a) + est(b).
 *
 * Calibrated against Claude's own tokenizer (review-log-phase5 A2, 2026-10-19): a real digest of 4,980 characters
 * (English and Czech) counted 2,204 Claude tokens (2.26 characters per token), the writer tools/list JSON (7,497
 * characters) 3,307. The old weight 1/3.5 undercounted by about 45 %; 1/2.2 slightly overcounts both, so a digest
 * with `est <= budget` stays within the budget in real tokens.
 */
export function estimateTokens(s: string): number {
  // Exact integer arithmetic in units of 1/66 token (1/2.2 = 30/66, 1/1.5 = 44/66, 2 = 132/66): no float drift.
  let units = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    units += cp < 0x370 ? 30 : cp <= 0xffff ? 44 : 132
  }
  return Math.ceil(units / 66)
}
