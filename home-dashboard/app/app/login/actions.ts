"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE, cookieOptions, makeToken, passcodeMatches } from "@/lib/session";

export async function signIn(_prev: { error?: string } | undefined, form: FormData) {
  const code = String(form.get("passcode") ?? "");
  if (!passcodeMatches(code)) return { error: "That passcode didn't match. Try again." };
  (await cookies()).set(COOKIE, makeToken(), cookieOptions);
  redirect("/");
}
