"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  buildCalendar, formatYears, HOLIDAY_CALENDAR_MAX_BYTES, HolidayCalendarInputError, type HolidayCalendarFile,
} from "@/domain/holiday-calendar";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  HolidayCalendarForbiddenError, holidayCalendarStore, HolidayCalendarUnavailableError, JURISDICTION_MAX,
} from "./holiday-calendar-store";

// Story 5.1: the Administrator loads the holiday calendar from one or more CSV files. Every load is a new
// version; there is no edit or delete action. Staff and manager sessions are refused.
const FORBIDDEN = "Only an Administrator can load the holiday calendar.";
const UNAVAILABLE = "The holiday calendar is temporarily unavailable. Nothing was saved.";
const NOTHING_SAVED = "Nothing was saved.";

const jurisdiction = z.string({ error: "Enter the jurisdiction." }).default("Bangladesh")
  .transform(value => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Enter the jurisdiction.").max(JURISDICTION_MAX, `Keep the jurisdiction to ${JURISDICTION_MAX} characters or fewer.`));

const NOT_CSV = "Choose calendar files ending in .csv.";
const fileEntry = z.instanceof(File, { error: NOT_CSV })
  .refine(file => /\.csv$/i.test(file.name), { error: NOT_CSV });

const loadForm = z.object({
  jurisdiction,
  files: z.array(fileEntry, { error: "Choose at least one calendar file (.csv)." })
    .min(1, "Choose at least one calendar file (.csv).")
    .refine(files => files.reduce((total, f) => total + f.size, 0) <= HOLIDAY_CALENDAR_MAX_BYTES, {
      error: `The calendar files are too large: keep them to ${HOLIDAY_CALENDAR_MAX_BYTES / 1024} KB in total.`,
    }),
});

/** Strict UTF-8: a file in another encoding is refused rather than silently decoded with U+FFFD. */
async function readUtf8(file: File): Promise<HolidayCalendarFile> {
  try {
    return { name: file.name, text: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) };
  } catch {
    throw new HolidayCalendarInputError(`${file.name} is not UTF-8 text. Save it as CSV UTF-8 and load it again.`);
  }
}

const failed = (error: string): ActionState => ({ error: `${error} ${NOTHING_SAVED}`, message: "" });

export async function loadHolidayCalendarAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin") return { error: FORBIDDEN, message: "" };

  const value = form.get("jurisdiction");
  // An empty file input still submits one nameless, empty File: that is "no file chosen".
  const files = form.getAll("files").filter(entry => !(entry instanceof File && entry.name === "" && entry.size === 0));
  const parsed = loadForm.safeParse({ jurisdiction: typeof value === "string" ? value : undefined, files });
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? "Check the calendar files.");

  try {
    const texts: HolidayCalendarFile[] = await Promise.all(parsed.data.files.map(readUtf8));
    const calendar = buildCalendar(texts);
    const saved = await holidayCalendarStore.load(session, {
      // The app only ever loads live calendars (the active one); 'test' is for the live tests.
      jurisdiction: parsed.data.jurisdiction, source: texts.map(f => f.name).join(", "), calendar, purpose: "live",
    });
    revalidatePath("/");
    const count = `${saved.holidayCount} ${saved.holidayCount === 1 ? "holiday" : "holidays"}`;
    return { error: "", message: `Holiday calendar version ${saved.version} loaded (${count}, ${formatYears(saved.supportedYearStart, saved.supportedYearEnd)}).` };
  } catch (error) {
    if (error instanceof HolidayCalendarInputError) return failed(error.message);
    if (error instanceof HolidayCalendarForbiddenError) return { error: FORBIDDEN, message: "" };
    // Never report success when the database could not be reached or refused the write.
    if (error instanceof HolidayCalendarUnavailableError) {
      console.error("Holiday calendar unavailable.", error, { cause: error.cause });
      return { error: UNAVAILABLE, message: "" };
    }
    throw error;
  }
}
