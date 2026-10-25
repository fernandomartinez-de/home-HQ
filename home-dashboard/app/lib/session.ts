import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const COOKIE = "hq_session";
const MAX_AGE = 60 * 60 * 24 * 90; // 90 days on a trusted device

const secret = () => process.env.SESSION_SECRET || process.env.HOME_API_KEY || "dev-only-secret";
const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("hex");

export function makeToken() {
  const issued = Math.floor(Date.now() / 1000).toString();
  return `${issued}.${sign(issued)}`;
}

export function validToken(token: string | undefined) {
  if (!token) return false;
  const [issued, sig] = token.split(".");
  if (!issued || !sig) return false;
  const expected = Buffer.from(sign(issued));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return Date.now() / 1000 - Number(issued) < MAX_AGE;
}

export async function signedIn() {
  // With no passcode configured (local development), the dashboard is open.
  if (!process.env.DASHBOARD_PASSCODE) return true;
  return validToken((await cookies()).get(COOKIE)?.value);
}

export function passcodeMatches(input: string) {
  const want = process.env.DASHBOARD_PASSCODE ?? "";
  const a = Buffer.from(sign(input));
  const b = Buffer.from(sign(want));
  return want.length > 0 && timingSafeEqual(a, b);
}

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE,
};
