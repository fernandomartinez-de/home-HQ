import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { runRoutine } from "@/lib/home";

export const dynamic = "force-dynamic";

// Run a routine now (the Morning and Night choices under the Home mode).
export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to control your home." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.name || typeof body.name !== "string") return NextResponse.json({ error: "Missing routine name." }, { status: 400 });
  try {
    return NextResponse.json(await runRoutine(body.name));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
