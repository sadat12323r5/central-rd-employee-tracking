"use server";

import { isAuthApiError, type SupabaseClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { employeesStore, EmployeesUnavailableError } from "./employees-store";
import { sessionHours, type SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// Administrators and Staff sign in with named Supabase Auth accounts (email + password). The session
// is the Supabase auth cookie; the identity comes from the user's `app_metadata`, which only the
// service role can set: `role: "admin"`, or `role: "staff"` with the linked `employee_id`.
// The HMAC demo cookie used before Story 1.3 is ignored and deleted on sign-in and sign-out.
const LEGACY_COOKIE = "bs23-demo-session";
const EMPLOYEE_ID = /^BS-\d{4}$/;

const INCORRECT = "The email or password is incorrect. Please try again.";
const UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again shortly.";

/** The identity a Supabase user's `app_metadata` grants, or null for any other role or a malformed claim. */
function identityFor(user: User | null | undefined): SessionIdentity | null {
  const metadata = user?.app_metadata ?? {};
  if (metadata.role === "admin") return { role: "admin" };
  if (metadata.role === "staff" && typeof metadata.employee_id === "string" && EMPLOYEE_ID.test(metadata.employee_id)) {
    return { role: "staff", employeeId: metadata.employee_id };
  }
  return null;
}

/** True when a sign-in time (ms since epoch) is known and within the identity's session length. */
function withinWindow(identity: SessionIdentity, signedInAt: number | undefined, now: number): boolean {
  return signedInAt !== undefined && Number.isFinite(signedInAt) && now - signedInAt < sessionHours(identity) * 60 * 60 * 1000;
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

async function supabaseSession(): Promise<SessionIdentity | null> {
  try {
    const client = await getUserClient();
    // getUser() asks Supabase Auth to validate the token; cookie contents alone are never trusted.
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return null;
    const identity = identityFor(data.user);
    if (!identity) return null;
    // Session length (FR-SESS-002: 8 h Administrator, 12 h Staff): both the account's last sign-in and
    // this session's own password sign-in must be recent, so a sign-in on another device cannot extend it.
    const now = Date.now();
    const lastSignIn = data.user.last_sign_in_at ? Date.parse(data.user.last_sign_in_at) : undefined;
    if (withinWindow(identity, lastSignIn, now) && withinWindow(identity, await passwordSignInAt(client), now)) return identity;
    await signOutSupabase(client);
    return null;
  } catch (error) {
    console.error("Session check failed.", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

export async function getSession(): Promise<SessionIdentity | null> {
  return supabaseSession();
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

async function supabaseSignIn(email: string, password: string): Promise<SignInResult> {
  if (!email || !password) return { error: INCORRECT };
  let client: SupabaseClient;
  try {
    client = await getUserClient();
  } catch (error) {
    console.error("Sign-in failed: Supabase is not configured.", error instanceof Error ? error.name : "unknown error");
    return { error: UNAVAILABLE };
  }
  let result: Awaited<ReturnType<SupabaseClient["auth"]["signInWithPassword"]>>;
  try {
    result = await client.auth.signInWithPassword({ email, password });
  } catch (error) {
    console.error("Sign-in failed: Supabase Auth unreachable.", error instanceof Error ? error.name : "unknown error");
    return { error: UNAVAILABLE };
  }
  const { data, error } = result;
  if (error) {
    if (isCredentialRejection(error)) return { error: INCORRECT };
    console.error("Sign-in failed: Supabase Auth error.", { name: error.name, status: error.status, code: error.code });
    return { error: UNAVAILABLE };
  }
  const identity = identityFor(data.user);
  if (!identity) {
    // A valid Supabase user without a recognised role gets no session and the same generic message.
    await signOutSupabase(client);
    return { error: INCORRECT };
  }
  if (identity.role === "staff") {
    // The staff account must reach its own employee row through RLS (employees_select_own).
    try {
      const employee = await employeesStore.getFor(identity, identity.employeeId);
      if (!employee) {
        await signOutSupabase(client);
        return { error: INCORRECT };
      }
    } catch (error) {
      await signOutSupabase(client);
      if (error instanceof EmployeesUnavailableError) {
        console.error("Sign-in failed: employee records unavailable.", error.name);
        return { error: UNAVAILABLE };
      }
      throw error;
    }
  }
  return { identity };
}

export async function signIn(_previous: { error: string }, form: FormData) {
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");

  const result = await supabaseSignIn(email, password);
  if ("error" in result) return { error: result.error };

  // The Supabase auth cookies were set by signInWithPassword; drop any pre-Story-1.3 demo cookie.
  (await cookies()).delete(LEGACY_COOKIE);
  redirect("/");
}

export async function signOut() {
  try {
    await signOutSupabase(await getUserClient());
  } catch {
    // Supabase not configured: there is no Supabase session to end.
  }
  (await cookies()).delete(LEGACY_COOKIE);
  redirect("/");
}
