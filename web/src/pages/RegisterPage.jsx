import { useState } from "react";
import api from "../services/api";
import "./console.css";

// Ask for an account. An admin approves the request; only then can the user sign in with the password chosen here.
const MIN_PASSWORD = 12;
const errText = (e) => e.response?.data?.message || e.message;

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password.length < MIN_PASSWORD) return setError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
    if (password !== again) return setError("The two passwords do not match.");
    setBusy(true);
    try {
      await api.post("/api/register", { email, password });
      setSent(true);
      setPassword("");
      setAgain("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="kc">
      <header className="kc-hero">
        <p className="kc-eyebrow">Get access</p>
        <h1>Request an account</h1>
        <p className="kc-lede">An admin approves each request. After that, sign in with the email and password you choose here.</p>
      </header>
      {sent ? (
        <section className="kc-card" aria-live="polite">
          <h2>Request sent</h2>
          <p>You will be able to sign in once an admin approves it. Requests that are not decided within 7 days expire.</p>
          <p><a href="/">Back to the playground</a></p>
        </section>
      ) : (
        <section className="kc-card">
          <form onSubmit={submit}>
            <label htmlFor="reg-email">Work email</label>
            <input id="reg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required />
            <label htmlFor="reg-pass">Password</label>
            <input id="reg-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128} required />
            <label htmlFor="reg-again">Repeat the password</label>
            <input id="reg-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" maxLength={128} required />
            {error && <div className="kc-banner kc-banner--error" role="alert">{error}</div>}
            <div className="kc-actions">
              <button type="submit" className="kc-btn kc-btn--primary" disabled={busy}>{busy ? "Sending…" : "Request account"}</button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
