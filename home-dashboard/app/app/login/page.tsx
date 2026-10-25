import { redirect } from "next/navigation";
import { signedIn } from "@/lib/session";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Login() {
  if (await signedIn()) redirect("/");
  return (
    <main className="login">
      <h1 className="login-title">Home</h1>
      <p className="login-note">Enter your passcode to control the apartment.</p>
      <LoginForm />
    </main>
  );
}
