"use server";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, verifySession } from "./session";

// This sign-in protects synthetic demonstration data only. Production identity uses Supabase.
const secret = process.env.DEMO_SESSION_SECRET || randomBytes(32).toString("hex");
const cookieName = "bs23-demo-session";

export async function isSignedIn() {
  return verifySession((await cookies()).get(cookieName)?.value, secret);
}

export async function signIn(_previous: { error: string }, form: FormData) {
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const expectedEmail = process.env.DEMO_ADMIN_EMAIL || "manager@example.com";
  const expectedPassword = process.env.DEMO_ADMIN_PASSWORD || "Brain23Demo!";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (email !== expectedEmail.toLowerCase() || !timingSafeEqual(hash(password), hash(expectedPassword))) {
    return { error: "The email or password is incorrect. Please try again." };
  }
  (await cookies()).set(cookieName, createSession(secret), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 8 * 60 * 60,
  });
  redirect("/");
}

export async function signOut() {
  (await cookies()).delete(cookieName);
  redirect("/");
}
