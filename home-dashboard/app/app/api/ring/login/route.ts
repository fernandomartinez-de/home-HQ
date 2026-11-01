import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { ringLogin, ringLogout } from "@/lib/home";

export const dynamic = "force-dynamic";

// Signs in to Ring. The password passes through to Ring once and isn't stored anywhere.
export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to connect Ring." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) return NextResponse.json({ error: "Enter your Ring email and password." }, { status: 400 });
  try {
    return NextResponse.json(await ringLogin(String(body.email), String(body.password), body.code ? String(body.code) : undefined));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message.replace(/ \(from .*\)$/, "") }, { status: 400 });
  }
}

export async function DELETE() {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  try {
    return NextResponse.json(await ringLogout());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
