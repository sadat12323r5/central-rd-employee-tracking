"use client";

import { useActionState, useState } from "react";
import { signIn } from "@/server/auth";

export default function Login({ showDemoCredentials }: { showDemoCredentials: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, action, pending] = useActionState(signIn, { error: "" });
  return <main className="login-page">
    <section className="login-story">
      <div className="brand"><span className="brand-mark">23</span><span>brain station <b>23</b><small>PEOPLE & DEVELOPMENT</small></span></div>
      <div className="login-message"><span className="eyebrow">THE PEOPLE BEHIND THE POSSIBILITIES</span><h1>Potential,<br />put into<br /><em>perspective.</em></h1><p>One place to understand your people, nurture their skills and support their next opportunity.</p></div>
      <div className="story-footer"><span>Learn. Grow. Move forward.</span><span>↗</span></div>
      <div className="orbit orbit-one" /><div className="orbit orbit-two" />
    </section>
    <section className="login-form-side"><div className="login-form-wrap">
      <span className="badge blue">L&D WORKSPACE</span><h2>Welcome back.</h2><p className="muted">Sign in to your people and development workspace.</p>
      <form action={action} className="login-form">
        <label htmlFor="email">Email address</label><input id="email" name="email" value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="username" required placeholder="you@company.com" />
        <label htmlFor="password">Password</label><input id="password" name="password" value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete="current-password" required placeholder="Enter your password" />
        {state.error && <p role="alert" className="form-error">{state.error}</p>}
        <button className="primary" disabled={pending}>{pending ? "Signing in…" : "Sign in to workspace →"}</button>
      </form>
      <div className="demo-note"><strong>Interactive demo · synthetic data</strong><p>This preview contains fictional employees. Production accounts and HR integrations are not connected.</p>{showDemoCredentials && <p>Email: <code>manager@example.com</code><br />Password: <code>Brain23Demo!</code></p>}</div>
      <p className="login-footnote">Brain Station 23 · L&D manager portal</p>
    </div></section>
  </main>;
}
