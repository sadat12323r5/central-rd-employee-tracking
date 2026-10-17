// Pure rules for adding a new employee (Story 7.1): normalising what a person types, checking it, and
// the fields derived from it (initials, avatar colour, the default join date). No framework or
// database imports. employees-store is the load-bearing check; the server action validates with zod first.

import { isCalendarDate } from "./dates";

export const EMPLOYEE_ID_PATTERN = /^BS-\d{4}$/;
/** The employment types in use. */
export const EMPLOYMENT_TYPES = ["Permanent", "Trainee", "Intern"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
/** The avatar colours the portal styles (one CSS class each). */
export const AVATAR_COLORS = ["lavender", "mint", "peach", "blue", "rose", "yellow"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const TEXT_FIELD_MAX = 120;
export const EMAIL_MAX = 254;

/** What the person enters. `joinedOn` is optional and defaults to today in Asia/Dhaka. */
export type NewEmployeeInput = {
  employeeId: string; name: string; title: string; team: string; email: string;
  /** Required: an id from the department list. */
  departmentId: string;
  /** The reporting manager, free text (the existing `manager` column). */
  manager: string;
  office: string; employmentType: string;
  joinedOn?: string | null;
};

/** The input after normalisation, with the join date resolved. */
export type NewEmployee = Required<{ [K in keyof NewEmployeeInput]: string }>;

export type NewEmployeeField = keyof NewEmployee;

/** Trims and collapses inner whitespace, so "  Nadia   Rahman " becomes "Nadia Rahman". */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Trimmed and lower-cased, as accounts-store treats emails. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// A deliberately plain shape check (something@domain.tld, no spaces); the action's zod email() is stricter.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DHAKA_DATE = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Dhaka" });

/** Today's calendar date (`YYYY-MM-DD`) in the Asia/Dhaka org timezone. */
export function todayInDhaka(now: Date = new Date()): string {
  const parts = Object.fromEntries(DHAKA_DATE.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** First letter of the first and last name words, upper-cased; a one-word name gives its first letter. */
export function initialsFor(name: string): string {
  const words = normalizeText(name).split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const first = (word: string) => Array.from(word)[0] ?? "";
  const letters = words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1]);
  return letters.toUpperCase();
}

/** One of the avatar colours, chosen deterministically from the Employee ID's digits. */
export function avatarColorFor(employeeId: string): AvatarColor {
  const digits = Number((employeeId.match(/\d/g) ?? ["0"]).join(""));
  return AVATAR_COLORS[digits % AVATAR_COLORS.length];
}

/** Normalises every field; a missing or blank join date becomes today in Asia/Dhaka. */
export function normalizeNewEmployee(input: NewEmployeeInput, now: Date = new Date()): NewEmployee {
  const joinedOn = (input.joinedOn ?? "").trim();
  return {
    employeeId: input.employeeId.trim(),
    name: normalizeText(input.name),
    title: normalizeText(input.title),
    team: normalizeText(input.team),
    email: normalizeEmail(input.email),
    departmentId: input.departmentId.trim(),
    manager: normalizeText(input.manager),
    office: normalizeText(input.office),
    employmentType: input.employmentType.trim(),
    joinedOn: joinedOn === "" ? todayInDhaka(now) : joinedOn,
  };
}

/** The fields of a normalised employee that break the rules, in form order; empty when valid. */
export function invalidNewEmployeeFields(employee: NewEmployee): NewEmployeeField[] {
  const invalid: NewEmployeeField[] = [];
  if (!EMPLOYEE_ID_PATTERN.test(employee.employeeId)) invalid.push("employeeId");
  for (const field of ["name", "title", "team"] as const) {
    if (employee[field].length < 1 || employee[field].length > TEXT_FIELD_MAX) invalid.push(field);
  }
  if (employee.email.length > EMAIL_MAX || !EMAIL_SHAPE.test(employee.email)) invalid.push("email");
  if (employee.departmentId === "") invalid.push("departmentId");
  for (const field of ["manager", "office"] as const) {
    if (employee[field].length < 1 || employee[field].length > TEXT_FIELD_MAX) invalid.push(field);
  }
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(employee.employmentType)) invalid.push("employmentType");
  if (!isCalendarDate(employee.joinedOn)) invalid.push("joinedOn");
  return invalid;
}

/** The fields a new employee gets without the form: never typed in, never taken from the request. */
export function derivedFields(employee: Pick<NewEmployee, "employeeId" | "name">) {
  return {
    status: "Available" as const,
    initials: initialsFor(employee.name),
    avatarColor: avatarColorFor(employee.employeeId),
    summary: "",
  };
}

// Story 7.2: editing an existing employee's basic details. Only these five fields; the department (and
// every other column) never changes here; a department changes only through a transfer.

/** What the person edits on an existing employee. */
export type EmployeeDetailsInput = {
  title: string; team: string;
  /** The reporting manager, free text (the existing `manager` column). */
  manager: string;
  office: string; employmentType: string;
};

export type EmployeeDetailsField = keyof EmployeeDetailsInput;

/** Trims and collapses inner whitespace in every field. */
export function normalizeEmployeeDetails(input: EmployeeDetailsInput): EmployeeDetailsInput {
  return {
    title: normalizeText(input.title),
    team: normalizeText(input.team),
    manager: normalizeText(input.manager),
    office: normalizeText(input.office),
    employmentType: normalizeText(input.employmentType),
  };
}

/** The fields of normalised details that break the rules, in form order; empty when valid. */
export function invalidEmployeeDetailsFields(details: EmployeeDetailsInput): EmployeeDetailsField[] {
  const invalid: EmployeeDetailsField[] = [];
  for (const field of ["title", "team", "manager", "office"] as const) {
    const value = details[field];
    if (typeof value !== "string" || value.length < 1 || value.length > TEXT_FIELD_MAX) invalid.push(field);
  }
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(details.employmentType)) invalid.push("employmentType");
  return invalid;
}
