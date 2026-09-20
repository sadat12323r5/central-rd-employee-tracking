const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export type LeaveCategory =
  | "ONE_TO_THREE"
  | "FOUR_TO_FOURTEEN"
  | "FIFTEEN_TO_THIRTY"
  | "THIRTY_ONE_TO_NINETY"
  | "NINETY_ONE_PLUS";

export interface LeaveCategoryDisplay {
  category: LeaveCategory;
  label: string;
  colour: `#${string}`;
}

export interface CalendarPolicy {
  holidays: ReadonlySet<string>;
  supportedYearStart: number;
  supportedYearEnd: number;
}

export class LeaveValidationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_DATE"
      | "REVERSED_RANGE"
      | "UNSUPPORTED_YEAR"
      | "ZERO_WORKING_DAYS",
    message: string,
  ) {
    super(message);
    this.name = "LeaveValidationError";
  }
}

function parseDate(value: string): Date {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new LeaveValidationError("INVALID_DATE", `Invalid ISO date: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new LeaveValidationError("INVALID_DATE", `Invalid calendar date: ${value}`);
  }

  return date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function assertSupported(date: Date, policy: CalendarPolicy): void {
  const year = date.getUTCFullYear();
  if (year < policy.supportedYearStart || year > policy.supportedYearEnd) {
    throw new LeaveValidationError(
      "UNSUPPORTED_YEAR",
      `Year ${year} is outside ${policy.supportedYearStart}-${policy.supportedYearEnd}`,
    );
  }
}

export function countWorkingDays(
  startValue: string,
  endValue: string,
  policy: CalendarPolicy,
): number {
  const start = parseDate(startValue);
  const end = parseDate(endValue);
  assertSupported(start, policy);
  assertSupported(end, policy);

  if (start.getTime() > end.getTime()) {
    throw new LeaveValidationError("REVERSED_RANGE", "Start date must not follow end date");
  }

  let workingDays = 0;
  for (let time = start.getTime(); time <= end.getTime(); time += DAY_MS) {
    const date = new Date(time);
    const weekday = date.getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    if (!isWeekend && !policy.holidays.has(toIsoDate(date))) {
      workingDays += 1;
    }
  }

  if (workingDays === 0) {
    throw new LeaveValidationError(
      "ZERO_WORKING_DAYS",
      "The selected range contains no working days",
    );
  }

  return workingDays;
}

export function categoryForWorkingDays(days: number): LeaveCategoryDisplay {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError("Working days must be a positive integer");
  }

  if (days <= 3) {
    return { category: "ONE_TO_THREE", label: "1–3 working days", colour: "#22C55E" };
  }
  if (days <= 14) {
    return { category: "FOUR_TO_FOURTEEN", label: "4–14 working days", colour: "#3B82F6" };
  }
  if (days <= 30) {
    return { category: "FIFTEEN_TO_THIRTY", label: "15–30 working days", colour: "#EAB308" };
  }
  if (days <= 90) {
    return { category: "THIRTY_ONE_TO_NINETY", label: "31–90 working days", colour: "#F97316" };
  }
  return { category: "NINETY_ONE_PLUS", label: "91+ working days", colour: "#A855F7" };
}

export function rangesOverlap(
  first: { startDate: string; endDate: string },
  second: { startDate: string; endDate: string },
): boolean {
  const firstStart = parseDate(first.startDate).getTime();
  const firstEnd = parseDate(first.endDate).getTime();
  const secondStart = parseDate(second.startDate).getTime();
  const secondEnd = parseDate(second.endDate).getTime();

  if (firstStart > firstEnd || secondStart > secondEnd) {
    throw new LeaveValidationError("REVERSED_RANGE", "Start date must not follow end date");
  }

  return firstStart <= secondEnd && secondStart <= firstEnd;
}
