// Story 5.1: parsing and checking holiday-calendar files (CSV) into one complete calendar. Pure.
//
// A calendar is loaded from one or more CSV files with the header exactly `date,name,kind`, where `date` is
// an ISO Asia/Dhaka calendar date, `name` is 1–200 characters and `kind` is `general`, `executive order` or
// `special` (see docs/holiday-calendars/README.md). The supported years are the years the dates fall in,
// which must be contiguous. The calendar is data, never code: nothing here knows any holiday.
//
// This module imports nothing at runtime (only types), so `scripts/seed-employees.ts` can load it directly
// with `node --experimental-strip-types`, which cannot resolve extensionless relative imports.
import type { CalendarPolicy } from "./leave";

export const HOLIDAY_KINDS = ["general", "executive order", "special"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

export type Holiday = { date: string; name: string; kind: HolidayKind };

/** One complete calendar: every holiday (sorted by date) and the contiguous years it covers. */
export type HolidayCalendar = { supportedYearStart: number; supportedYearEnd: number; holidays: Holiday[] };

export type HolidayCalendarFile = { name: string; text: string };

export const HOLIDAY_CSV_HEADER = "date,name,kind";
export const HOLIDAY_NAME_MAX = 200;
/** Limits for one load (all files together). */
export const HOLIDAY_CALENDAR_MAX_BYTES = 200 * 1024;
export const HOLIDAY_CALENDAR_MAX_ROWS = 1000;
export const ORG_TIMEZONE = "Asia/Dhaka";

/** The calendar files are not acceptable; `message` says why (with the file and line where applicable). */
export class HolidayCalendarInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HolidayCalendarInputError";
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in `YYYY-MM-DD` form (same rule as `isCalendarDate` in dates.ts). */
function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

type CsvRecord = { line: number; fields: string[] };

/**
 * Splits CSV text into records (RFC 4180 style): fields may be quoted, `""` inside quotes is a quote, and
 * a quoted field may span lines. CRLF and LF both end a record. `line` is the record's first line.
 */
function splitRecords(text: string, fileName: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false; // inside a quoted field
  let closed = false; // just after a quoted field's closing quote
  let line = 1;
  let recordLine = 1;
  const endField = () => { fields.push(field); field = ""; closed = false; };
  const endRecord = () => { endField(); records.push({ line: recordLine, fields }); fields = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
      } else {
        if (char === "\n") line++;
        field += char;
      }
      continue;
    }
    if (char === ",") {
      endField();
    } else if (char === "\r" && text[i + 1] === "\n") {
      // CRLF: the \n ends the record.
    } else if (char === "\n" || char === "\r") {
      endRecord();
      line++;
      recordLine = line;
    } else if (closed) {
      throw new HolidayCalendarInputError(`${fileName} line ${line}: unexpected text after a closing quote.`);
    } else if (char === '"') {
      if (field !== "") {
        throw new HolidayCalendarInputError(`${fileName} line ${line}: a quote must start the field (write it as "" inside a quoted field).`);
      }
      quoted = true;
    } else {
      field += char;
    }
  }
  if (quoted) throw new HolidayCalendarInputError(`${fileName} line ${recordLine}: a quoted field is never closed.`);
  if (field !== "" || closed || fields.length > 0) endRecord();
  return records;
}

const isBlank = (record: CsvRecord) => record.fields.length === 1 && record.fields[0].trim() === "";

/** Parses one calendar file into its holidays (in file order), with the line each came from. */
export function parseHolidayCsv(text: string, fileName: string): (Holiday & { line: number })[] {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const records = splitRecords(body, fileName);
  while (records.length > 0 && isBlank(records[records.length - 1])) records.pop();
  if (records.length === 0) throw new HolidayCalendarInputError(`${fileName} is empty. Add the header ${HOLIDAY_CSV_HEADER} and one row per holiday.`);

  const [header, ...rows] = records;
  if (header.fields.join(",") !== HOLIDAY_CSV_HEADER) {
    throw new HolidayCalendarInputError(`${fileName} line 1: the header must be exactly ${HOLIDAY_CSV_HEADER}.`);
  }
  if (rows.length === 0) throw new HolidayCalendarInputError(`${fileName} has no holidays. Add one row per holiday under the header.`);

  const seen = new Map<string, number>();
  return rows.map(({ line, fields }) => {
    const at = `${fileName} line ${line}`;
    if (isBlank({ line, fields })) throw new HolidayCalendarInputError(`${at} is empty. Remove the blank line.`);
    if (fields.length !== 3) throw new HolidayCalendarInputError(`${at}: expected 3 values (date, name, kind), found ${fields.length}.`);
    const date = fields[0].trim();
    const name = fields[1].trim().replace(/\s+/g, " ");
    const kind = fields[2].trim();
    if (!isIsoDate(date)) throw new HolidayCalendarInputError(`${at}: "${date}" is not a valid date. Use YYYY-MM-DD.`);
    if (name.length < 1 || name.length > HOLIDAY_NAME_MAX) {
      throw new HolidayCalendarInputError(`${at}: the holiday name must be 1 to ${HOLIDAY_NAME_MAX} characters.`);
    }
    if (!(HOLIDAY_KINDS as readonly string[]).includes(kind)) {
      throw new HolidayCalendarInputError(`${at}: "${kind}" is not a holiday kind. Use general, executive order or special.`);
    }
    const earlier = seen.get(date);
    if (earlier !== undefined) throw new HolidayCalendarInputError(`${at}: ${date} is already listed on line ${earlier}.`);
    seen.set(date, line);
    return { date, name, kind: kind as HolidayKind, line };
  });
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** "2027", "2027 and 2028", "2027, 2028 and 2029". */
function listYears(years: number[]): string {
  if (years.length === 1) return String(years[0]);
  return `${years.slice(0, -1).join(", ")} and ${years[years.length - 1]}`;
}

/**
 * Builds one complete calendar from one or more files: every rule of a single file (parseHolidayCsv), no
 * date listed twice across files, the size and row limits, and contiguous supported years.
 */
export function buildCalendar(files: readonly HolidayCalendarFile[]): HolidayCalendar {
  if (files.length === 0) throw new HolidayCalendarInputError("Choose at least one calendar file (.csv).");
  const bytes = files.reduce((total, file) => total + byteLength(file.text), 0);
  if (bytes > HOLIDAY_CALENDAR_MAX_BYTES) {
    throw new HolidayCalendarInputError(`The calendar files are too large: keep them to ${HOLIDAY_CALENDAR_MAX_BYTES / 1024} KB in total.`);
  }

  const holidays: Holiday[] = [];
  const from = new Map<string, string>();
  for (const file of files) {
    for (const { line, ...holiday } of parseHolidayCsv(file.text, file.name)) {
      const other = from.get(holiday.date);
      if (other !== undefined) {
        throw new HolidayCalendarInputError(`${file.name} line ${line}: ${holiday.date} is already listed in ${other}.`);
      }
      from.set(holiday.date, file.name);
      holidays.push(holiday);
    }
  }
  if (holidays.length > HOLIDAY_CALENDAR_MAX_ROWS) {
    throw new HolidayCalendarInputError(`The calendar has ${holidays.length} holidays: keep it to ${HOLIDAY_CALENDAR_MAX_ROWS} rows or fewer.`);
  }

  holidays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const years = new Set(holidays.map(h => Number(h.date.slice(0, 4))));
  const supportedYearStart = Math.min(...years);
  const supportedYearEnd = Math.max(...years);
  const missing: number[] = [];
  for (let year = supportedYearStart; year <= supportedYearEnd; year++) if (!years.has(year)) missing.push(year);
  if (missing.length > 0) {
    throw new HolidayCalendarInputError(`The calendar must cover consecutive years: add ${listYears(missing)} too.`);
  }
  return { supportedYearStart, supportedYearEnd, holidays };
}

/** The calendar as the policy `countWorkingDays` (leave.ts) expects. */
export function toCalendarPolicy(calendar: Pick<HolidayCalendar, "supportedYearStart" | "supportedYearEnd"> & { holidays: readonly { date: string }[] }): CalendarPolicy {
  return {
    holidays: new Set(calendar.holidays.map(h => h.date)),
    supportedYearStart: calendar.supportedYearStart,
    supportedYearEnd: calendar.supportedYearEnd,
  };
}

/** "2026" or "2026–2027". */
export function formatYears(start: number, end: number): string {
  return start === end ? String(start) : `${start}–${end}`;
}
