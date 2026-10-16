import { formatDisplayDay } from "./dates";
import type { Department } from "./departments";

// Story 4.6: how an assignment evaluation's authorship is shown. Pure (no framework or database imports).
// Authors are auth user ids; they are never shown raw. A name is shown when the account is a department's
// manager whose linked employee the viewer can see; otherwise role words: a manager's account with no
// visible employee is "a manager", a department's manager account with no employee row at all is an
// Administrator's ("the Administrator"), and an account the viewer cannot place (for example Staff, who
// see no departments, or an Administrator who manages nothing) is "a manager or the Administrator".

/** Who an author id is, for display. */
export type AuthorName = (userId: string) => string;

export const UNKNOWN_AUTHOR = "a manager or the Administrator";

/** The evaluation fields authorship needs. */
type Authored = { createdBy: string; createdAt: string; authoredBy: string; updatedAt: string };

/** A resolver over what the viewer can see: the department list (managers' accounts) and the employees (names). */
export function authorNames(
  departments: Pick<Department, "managerUserId" | "managerEmployeeId">[], employees: { id: string; name: string }[],
): AuthorName {
  return userId => {
    const managed = departments.find(d => d.managerUserId !== null && d.managerUserId === userId);
    if (!managed) return UNKNOWN_AUTHOR;
    if (managed.managerEmployeeId === null) return "the Administrator";
    return employees.find(e => e.id === managed.managerEmployeeId)?.name ?? "a manager";
  };
}

/** True when the evaluation was changed after it was first written. */
export const isAmended = (evaluation: Authored) => evaluation.updatedAt !== evaluation.createdAt || evaluation.authoredBy !== evaluation.createdBy;

/** "Written by X on D MMM YYYY", plus " · amended by Y on D MMM YYYY" when it was amended. */
export function authorshipText(evaluation: Authored, name: AuthorName = () => UNKNOWN_AUTHOR): string {
  const written = `Written by ${name(evaluation.createdBy)} on ${formatDisplayDay(evaluation.createdAt)}`;
  return isAmended(evaluation) ? `${written} · amended by ${name(evaluation.authoredBy)} on ${formatDisplayDay(evaluation.updatedAt)}` : written;
}
