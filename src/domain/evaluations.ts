import type { AuthorRole } from "@/data/employees";
import { formatDisplayDay } from "./dates";

// Story 4.6: how an assignment evaluation's authorship is shown. Pure (no framework or database imports).
// Authors are auth user ids and are never shown raw. The label comes only from the snapshot the database
// stored with each write (the writer's display name and role at that time), so every viewer, Staff
// included, sees the same text whatever departments they can see and whoever manages them now.

/** The evaluation fields authorship needs. */
type Authored = {
  createdBy: string; createdByName: string | null; createdByRole: AuthorRole; createdAt: string;
  authoredBy: string; authoredByName: string | null; authoredByRole: AuthorRole; updatedAt: string;
};

/** The stored name, else the role words: "the Administrator" or "a manager". */
export function authorLabel(name: string | null | undefined, role: AuthorRole): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return role === "admin" ? "the Administrator" : "a manager";
}

/** True when the evaluation was changed after it was first written. */
export const isAmended = (evaluation: Authored) => evaluation.updatedAt !== evaluation.createdAt || evaluation.authoredBy !== evaluation.createdBy;

/** "Written by X on D MMM YYYY", plus " · amended by Y on D MMM YYYY" when it was amended. */
export function authorshipText(evaluation: Authored): string {
  const written = `Written by ${authorLabel(evaluation.createdByName, evaluation.createdByRole)} on ${formatDisplayDay(evaluation.createdAt)}`;
  if (!isAmended(evaluation)) return written;
  return `${written} · amended by ${authorLabel(evaluation.authoredByName, evaluation.authoredByRole)} on ${formatDisplayDay(evaluation.updatedAt)}`;
}
