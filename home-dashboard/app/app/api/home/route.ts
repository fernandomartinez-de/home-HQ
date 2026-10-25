import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { getHome } from "@/lib/home";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to see your home." }, { status: 401 });
  try {
    return NextResponse.json(await getHome(24));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
