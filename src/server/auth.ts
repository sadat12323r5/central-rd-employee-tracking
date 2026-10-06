"use server";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { isAuthApiError, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { employeesStore, EmployeesUnavailableError } from "./employees-store";
import { createSession, readSession, sessionHours, type SessionIdentity, type StaffIdentity } from "./session";
import { getUserClient } from "./supabase";

// Administrators sign in with a named Supabase Auth account (email + password); the session is the
// Supabase auth cookie and `admin` comes from the user's `app_metadata.role`, which only the
// service role can set. Demo staff still use the HMAC cookie below until Story 1.3 (staged cutover).
// Next.js can load this module more than once (page render vs. server actions), so the
// fallback secret is kept on globalThis to make every copy sign and verify with the same key.
const holder = globalThis as typeof globalThis & { __bs23DemoSecret?: string };
const secret = process.env.DEMO_SESSION_SECRET || (holder.__bs23DemoSecret ??= randomBytes(32).toString("hex"));
const cookieName = "bs23-demo-session";

const ADMIN_SESSION_MS = sessionHours({ role: "admin" }) * 60 * 60 * 1000;
const INCORRECT = "The email or password is incorrect. Please try again.";
const UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again shortly.";

/** True when a sign-in time (ms since epoch) is known and under 8 hours old. */
function withinAdminWindow(signedInAt: number | undefined, now: number): boolean {
  return signedInAt !== undefined && Number.isFinite(signedInAt) && now - signedInAt < ADMIN_SESSION_MS;
}

/**
 * When THIS session signed in with a password: the `amr` "password" entry of its access token.
 * Only called after getUser() has validated that same token with Supabase Auth.
 */
async function passwordSignInAt(client: SupabaseClient): Promise<number | undefined> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    const entry = Array.isArray(claims.amr) ? claims.amr.find((a: { method?: unknown }) => a?.method === "password") : undefined;
    return typeof entry?.timestamp === "number" ? entry.timestamp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Errors Supabase raises for rejected credentials (4xx), as opposed to outages, rate limits or network failures. */
function isCredentialRejection(error: unknown): boolean {
  return isAuthApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429;
}

async function adminSession(): Promise<SessionIdentity | null> {
  try {
    const client = await getUserClient();
    // getUser() asks Supabase Auth to validate the token; cookie contents alone are never trusted.
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.app_metadata?.role !== "admin") return null;
    // 8-hour Administrator session (FR-SESS-002): both the account's last sign-in and this session's
    // own password sign-in must be recent, so a sign-in on another device cannot extend this one.
    const now = Date.now();
    const lastSignIn = data.user.last_sign_in_at ? Date.parse(data.user.last_sign_in_at) : undefined;
    if (withinAdminWindow(lastSignIn, now) && withinAdminWindow(await passwordSignInAt(client), now)) return { role: "admin" };
    await signOutSupabase(client);
    return null;
  } catch (error) {
    console.error("Administrator session check failed.", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

export async function getSession(): Promise<SessionIdentity | null> {
  const admin = await adminSession();
  if (admin) return admin;
  return readSession((await cookies()).get(cookieName)?.value, secret);
}

export async function isSignedIn() {
  return (await getSession())?.role === "admin";
}

async function signOutSupabase(client: SupabaseClient) {
  try {
    await client.auth.signOut({ scope: "local" });
  } catch {
    // Best effort: the local auth cookies are cleared by the client even if revocation fails.
  }
}

type SignInResult = { identity: SessionIdentity } | { error: string };

async function staffSignIn(email: string, password: string): Promise<SignInResult | null> {
  const staffPassword = process.env.DEMO_STAFF_PASSWORD || "Staff23Demo!";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(password), hash(staffPassword))) return null;
  // Demo staff accounts: each fictional employee signs in with their employee email.
  // The password is checked first so a wrong password never costs a database round trip.
  try {
    const employee = await employeesStore.findByEmail(email);
    return employee ? { identity: { role: "staff", employeeId: employee.id } } : null;
  } catch (error) {
    if (error instanceof EmployeesUnavailableError) {
      console.error("Staff sign-in failed: employee records unavailable.", error, { cause: error.cause });
      return { error: UNAVAILABLE };
    }
    throw error;
  }
}

async function adminSignIn(email: string, password: string): Promise<SignInResult> {
  if (!email || !password) return { error: INCORRECT };
  let client: SupabaseClient;
  try {
    client = await getUserClient();
  } catch (error) {
    console.error("Administrator sign-in failed: Supabase is not configured.", error instanceof Error ? error.name : "unknown error");
    return { error: UNAVAILABLE };
  }
  let result: Awaited<ReturnType<SupabaseClient["auth"]["signInWithPassword"]>>;
  try {
    result = await client.auth.signInWithPassword({ email, password });
  } catch (error) {
    console.error("Administrator sign-in failed: Supabase Auth unreachable.", error instanceof Error ? error.name : "unknown error");
    return { error: UNAVAILABLE };
  }
  const { data, error } = result;
  if (error) {
    if (isCredentialRejection(error)) return { error: INCORRECT };
    console.error("Administrator sign-in failed: Supabase Auth error.", { name: error.name, status: error.status, code: error.code });
    return { error: UNAVAILABLE };
  }
  if (data.user?.app_metadata?.role !== "admin") {
    // A valid Supabase user without the admin role gets no session and the same generic message.
    await signOutSupabase(client);
    return { error: INCORRECT };
  }
  return { identity: { role: "admin" } };
}

export async function signIn(_previous: { error: string }, form: FormData) {
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");

  const result = (await staffSignIn(email, password)) ?? (await adminSignIn(email, password));
  if ("error" in result) return { error: result.error };

  const store = await cookies();
  if (result.identity.role === "staff") {
    // getSession() checks Supabase first, so end any Administrator session in this browser.
    try {
      await signOutSupabase(await getUserClient());
    } catch {
      // Supabase not configured: there is no Supabase session to end.
    }
    const identity: StaffIdentity = result.identity;
    store.set(cookieName, createSession(secret, Date.now(), identity), {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: sessionHours(identity) * 60 * 60,
    });
  } else {
    // The Supabase auth cookies were set by signInWithPassword; drop any older staff session.
    store.delete(cookieName);
  }
  redirect("/");
}

export async function signOut() {
  try {
    await signOutSupabase(await getUserClient());
  } catch {
    // Supabase not configured: there is no Supabase session to end.
  }
  (await cookies()).delete(cookieName);
  redirect("/");
}
