import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { ringLiveEnd, ringLiveStart } from "@/lib/home";

export const dynamic = "force-dynamic";

// Live view: {action:"start", id, sdp} returns Ring's WebRTC answer; {action:"end", session_id} stops it.
// The video itself streams from Ring straight to the browser, not through here.
export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to see the camera." }, { status: 401 });
  const body = await req.json().catch(() => null);
  try {
    if (body?.action === "start" && body.id && body.sdp) return NextResponse.json(await ringLiveStart(String(body.id), String(body.sdp)));
    if (body?.action === "end") return NextResponse.json(await ringLiveEnd(String(body.session_id ?? "")));
    return NextResponse.json({ error: "Missing action, id or sdp." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message.replace(/ \(from .*\)$/, "") }, { status: 502 });
  }
}
