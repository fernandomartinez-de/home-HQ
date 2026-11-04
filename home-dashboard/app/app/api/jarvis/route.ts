import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { askJarvis } from "@/lib/home";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Voice requests from the Jarvis mic button.
export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to control your home.", reply: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.text || typeof body.text !== "string") return NextResponse.json({ error: "Missing text.", reply: "I didn't catch that." }, { status: 400 });
  try {
    return NextResponse.json(await askJarvis(body.text, Array.isArray(body.history) ? body.history : []));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, reply: "Sorry, I couldn't reach the house." }, { status: 502 });
  }
}
