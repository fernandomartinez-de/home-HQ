import { NextResponse } from "next/server";
import { signedIn } from "@/lib/session";
import { ringSnapshot } from "@/lib/home";

export const dynamic = "force-dynamic";

// The latest camera snapshot as an image. ?force=1 asks a wired camera for a fresh one.
export async function GET(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in to see the camera." }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  const snap = await ringSnapshot(id, url.searchParams.get("force") === "1");
  if ("error" in snap) return NextResponse.json({ error: snap.error }, { status: 502 });
  return new NextResponse(snap.image, {
    headers: {
      "Content-Type": "svg" in snap ? "image/svg+xml" : "image/jpeg",
      "Cache-Control": "private, no-store",
      ...(snap.takenMs ? { "x-snapshot-ms": String(snap.takenMs) } : {}),
    },
  });
}
