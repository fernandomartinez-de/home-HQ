import { redirect } from "next/navigation";
import { signedIn } from "@/lib/session";
import { getHome } from "@/lib/home";
import Dashboard from "@/components/Dashboard";
import type { HomeData } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Page() {
  if (!(await signedIn())) redirect("/login");
  let data: HomeData = { devices: [] };
  let error: string | null = null;
  try {
    data = await getHome(24);
  } catch (err) {
    error = (err as Error).message;
  }
  return <Dashboard initial={data} initialError={error} />;
}
