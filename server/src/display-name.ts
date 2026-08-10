/**
 * The one implementation of the public display-name masking rule -- `display_name` is
 * either an OAuth-provided name or, for a never-signed-in guest, sometimes an email
 * address (docs/player-model.md's documented fallback risk). An `@`-containing name
 * never reaches a response a stranger can read; `routes/profile.ts` and `ranking.ts`
 * both call this rather than re-deriving the check.
 */
export function maskDisplayName(raw: string | null): string {
  return raw && !raw.includes("@") ? raw : "Anonymous Operator";
}
