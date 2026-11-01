import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { getAnalytics } from "@/lib/home";

export const dynamic = "force-dynamic";

// History tab data: GET /api/history?days=14
export async function GET(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to see your home." }, { status: 401 });
  const days = Number(new URL(req.url).searchParams.get("days")) || 14;
  try {
    return NextResponse.json(await getAnalytics(days));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message.replace(/ \(from .*\)$/, "") }, { status: 502 });
  }
}
