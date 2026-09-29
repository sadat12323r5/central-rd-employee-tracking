"use server";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { employees } from "@/data/employees";
import { createSession, readSession, sessionHours, verifySession, type SessionIdentity } from "./session";

// This sign-in protects synthetic demonstration data only. Production identity uses Supabase.
// Next.js can load this module more than once (page render vs. server actions), so the
// fallback secret is kept on globalThis to make every copy sign and verify with the same key.
const holder = globalThis as typeof globalThis & { __bs23DemoSecret?: string };
const secret = process.env.DEMO_SESSION_SECRET || (holder.__bs23DemoSecret ??= randomBytes(32).toString("hex"));
const cookieName = "bs23-demo-session";

export async function isSignedIn() {
  return verifySession((await cookies()).get(cookieName)?.value, secret);
}

export async function getSession(): Promise<SessionIdentity | null> {
  return readSession((await cookies()).get(cookieName)?.value, secret);
}

export async function signIn(_previous: { error: string }, form: FormData) {
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const expectedEmail = process.env.DEMO_ADMIN_EMAIL || "manager@example.com";
  const expectedPassword = process.env.DEMO_ADMIN_PASSWORD || "Brain23Demo!";
  const staffPassword = process.env.DEMO_STAFF_PASSWORD || "Staff23Demo!";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const matches = (expected: string) => timingSafeEqual(hash(password), hash(expected));

  let identity: SessionIdentity | null = null;
  if (email === expectedEmail.toLowerCase() && matches(expectedPassword)) {
    identity = { role: "admin" };
  } else {
    // Demo staff accounts: each fictional employee signs in with their fixture email.
    const employee = employees.find(e => e.email.toLowerCase() === email);
    if (employee && matches(staffPassword)) identity = { role: "staff", employeeId: employee.id };
  }
  if (!identity) return { error: "The email or password is incorrect. Please try again." };

  (await cookies()).set(cookieName, createSession(secret, Date.now(), identity), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: sessionHours(identity) * 60 * 60,
  });
  redirect("/");
}

export async function signOut() {
  (await cookies()).delete(cookieName);
  redirect("/");
}
