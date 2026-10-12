"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import { interviewsStore, InterviewsForbiddenError, InterviewsUnavailableError } from "./interviews-store";

const SIGN_IN = "Your session has ended. Sign in again as a staff member to add an interview.";
const UNAVAILABLE = "External interviews could not be reached, so nothing was saved. Please try again in a moment.";

const text = (label: string, max: number) =>
  z.string({ error: `Enter the ${label}.` }).trim().min(1, `Enter the ${label}.`).max(max, `Keep the ${label} to ${max} characters or fewer.`);

// Lengths match the external_interviews check constraints. The form's employeeId (if any) is not part
// of the schema: the employee always comes from the signed-in session.
const newInterview = z.object({
  company: text("company", 200),
  role: text("role", 200),
  date: z.string({ error: "Enter the interview date." }).trim()
    .refine(isCalendarDate, "Enter the interview date as a real date (YYYY-MM-DD)."),
  stage: text("stage", 200),
  outcome: z.string().trim().max(200, "Keep the outcome to 200 characters or fewer.").default(""),
});

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

export async function addInterviewAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "staff") return { error: SIGN_IN, message: "" };

  const parsed = newInterview.safeParse({
    company: field(form, "company"), role: field(form, "role"), date: field(form, "date"),
    stage: field(form, "stage"), outcome: field(form, "outcome"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the interview details.", message: "" };

  try {
    await interviewsStore.add(session, parsed.data);
  } catch (error) {
    if (error instanceof InterviewsForbiddenError) return { error: SIGN_IN, message: "" };
    // Never report success when the database could not be reached or refused the write.
    if (error instanceof InterviewsUnavailableError) {
      console.error("External interviews unavailable.", error, { cause: error.cause });
      return { error: UNAVAILABLE, message: "" };
    }
    throw error;
  }
  revalidatePath("/");
  return { error: "", message: "Interview added." };
}
