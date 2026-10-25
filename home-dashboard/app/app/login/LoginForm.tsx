"use client";
import { useActionState } from "react";
import { signIn } from "./actions";

export default function LoginForm() {
  const [state, action, pending] = useActionState(signIn, undefined);
  return (
    <form action={action} className="login-form">
      <label htmlFor="passcode" className="sr-only">Passcode</label>
      <input id="passcode" name="passcode" type="password" inputMode="numeric" autoComplete="current-password"
        placeholder="Passcode" autoFocus required className="login-input" />
      <button type="submit" className="btn btn-brass" disabled={pending}>{pending ? "Signing in" : "Sign in"}</button>
      {state?.error && <p role="alert" className="login-error">{state.error}</p>}
    </form>
  );
}
