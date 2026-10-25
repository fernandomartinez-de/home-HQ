import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { enableSchedule, getSchedule, saveSchedule } from "@/lib/home";

export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Sign in to manage schedules." }, { status: 401 });
const fail = (err: unknown) => NextResponse.json({ error: (err as Error).message }, { status: 502 });

export async function GET(req: Request) {
  if (!(await signedIn())) return unauthorized();
  const id = new URL(req.url).searchParams.get("device_id");
  if (!id) return NextResponse.json({ error: "Missing device_id." }, { status: 400 });
  try { return NextResponse.json(await getSchedule(id)); } catch (err) { return fail(err); }
}

// Save the whole week.
export async function PUT(req: Request) {
  if (!(await signedIn())) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body?.device_id || !Array.isArray(body?.blocks)) {
    return NextResponse.json({ error: "Missing device_id or blocks." }, { status: 400 });
  }
  try { return NextResponse.json(await saveSchedule(body.device_id, body.blocks)); } catch (err) { return fail(err); }
}

// Turn the schedule on or off. Turning it on applies the current slot right away.
export async function POST(req: Request) {
  if (!(await signedIn())) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body?.device_id || typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Missing device_id or enabled." }, { status: 400 });
  }
  try { return NextResponse.json(await enableSchedule(body.device_id, body.enabled)); } catch (err) { return fail(err); }
}
