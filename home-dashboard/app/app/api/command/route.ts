import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { sendCommand } from "@/lib/home";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to control your home." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.provider || !body?.device_id || !body?.command) {
    return NextResponse.json({ error: "Missing provider, device_id or command." }, { status: 400 });
  }
  try {
    return NextResponse.json(await sendCommand(body.provider, body.device_id, body.command));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
