import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { refreshHome } from "@/lib/home";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to see your home." }, { status: 401 });
  try {
    return NextResponse.json(await refreshHome());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
