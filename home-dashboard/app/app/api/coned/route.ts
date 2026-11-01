import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { conedConnect, conedDisconnect } from "@/lib/home";

export const dynamic = "force-dynamic";
// A first sign in can wait up to 30 seconds for a fresh authenticator code.
export const maxDuration = 90;

// Connects Con Edison: the coned function signs in once to check the details, then keeps them in
// Supabase Vault for the scheduled poll.
export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to connect Con Edison." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) return NextResponse.json({ error: "Enter your Con Edison email and password." }, { status: 400 });
  try {
    return NextResponse.json(await conedConnect(String(body.email), String(body.password), body.totp ? String(body.totp) : undefined));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message.replace(/ \(from .*\)$/, "") }, { status: 400 });
  }
}

export async function DELETE() {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  try {
    return NextResponse.json(await conedDisconnect());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
