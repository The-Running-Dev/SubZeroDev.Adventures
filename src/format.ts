/** Short, no year -- a reader looking at this wants to know "did that just happen," not
 *  an audit trail. `undefined` renders as an em dash rather than "Invalid Date". Lifted
 *  out of `AdminPanel.tsx` (its original home) so `src/discussions/Discussions.tsx` can
 *  share it rather than re-deriving the same formatting rule a second time. */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
