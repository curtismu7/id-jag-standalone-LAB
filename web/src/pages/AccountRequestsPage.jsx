import { useCallback, useEffect, useState } from "react";
import api from "../services/api";
import { useMe } from "../auth/useMe";
import { signIn } from "../utils/signIn";
import "./console.css";

// Admin queue for account requests: approve creates the user in PingFederate; reject can say why.
const API = "/api/registrations";
const STATUS = { pending: "Pending review", approved: "Approved", rejected: "Rejected", expired: "Expired" };
const errText = (e) => e.response?.data?.message || e.response?.data?.error || e.message;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

export default function AccountRequestsPage() {
  const me = useMe();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setRows((await api.get(API)).data.registrations);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => { if (me?.isAdmin) load(); }, [me, load]);

  async function decide(id, action, body) {
    setError("");
    setBusy(id);
    try {
      await api.post(`${API}/${id}/${action}`, body);
      setRejecting(null);
      setReason("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
      await load();
    }
  }

  const pending = (rows || []).filter((r) => r.status === "pending");
  const decided = (rows || []).filter((r) => r.status !== "pending");

  return (
    <main className="kc">
      <header className="kc-hero">
        <p className="kc-eyebrow">Admin</p>
        <h1>Account requests</h1>
        <p className="kc-lede">Approving creates the user in PingFederate with the password they chose. Their password is deleted from this app as soon as you decide.</p>
      </header>
      {me === undefined && <p className="kc-note">Loading…</p>}
      {me === null && (
        <section className="kc-card">
          <p>Sign in as an admin to review requests.</p>
          <button type="button" className="kc-btn kc-btn--primary" onClick={() => signIn()}>Sign in</button>
        </section>
      )}
      {me && !me.isAdmin && <section className="kc-card"><p>Only admins can review account requests.</p></section>}
      {me?.isAdmin && (
        <>
          {error && <div className="kc-banner kc-banner--error" role="alert">{error}</div>}
          <section className="kc-card" aria-label="Pending requests">
            <h2>Pending</h2>
            {rows && !pending.length && <p className="kc-note">No requests waiting.</p>}
            <ul className="kc-list">
              {pending.map((r) => (
                <li key={r.id} className="kc-idp">
                  <strong>{r.email}</strong> <span className="kc-badge kc-badge--pending">{STATUS.pending}</span>
                  <span className="kc-note"> requested {when(r.createdAt)}</span>
                  {rejecting === r.id ? (
                    <div className="kc-actions">
                      <label htmlFor={`why-${r.id}`}>Reason (shown in the audit log)</label>
                      <input id={`why-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
                      <button type="button" className="kc-btn kc-btn--danger" disabled={busy === r.id} onClick={() => decide(r.id, "reject", { reason })}>Confirm reject</button>
                      <button type="button" className="kc-btn" onClick={() => setRejecting(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="kc-actions">
                      <button type="button" className="kc-btn kc-btn--primary" disabled={busy === r.id} onClick={() => decide(r.id, "approve", {})}>Approve</button>
                      <button type="button" className="kc-btn" onClick={() => { setRejecting(r.id); setReason(""); }}>Reject</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {!!decided.length && (
            <section className="kc-card" aria-label="Decided requests">
              <h2>Decided</h2>
              <ul className="kc-list">
                {decided.map((r) => (
                  <li key={r.id} className="kc-idp">
                    <strong>{r.email}</strong> <span className={`kc-badge kc-badge--${r.status}`}>{STATUS[r.status] || r.status}</span>
                    <span className="kc-note"> {r.decidedBy ? `by ${r.decidedBy} ` : ""}{when(r.decidedAt)}{r.reason ? `: ${r.reason}` : ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
