import type { Submission } from "../api/content";
export function statusLabel(submission: Submission): string {
  if (submission.visibility === "public") return "public";
  if (submission.status === "pending") return "pending";
  if (submission.status === "rejected") return "rejected";
  return "private";
}
