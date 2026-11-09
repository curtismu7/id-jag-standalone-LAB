import { useEffect, useRef, useState } from "react";
import { useAppMode } from "../mode/ModeContext";
import FloatingDialog from "../floating-dialog/FloatingDialog";
import "./SignInModal.css";

const ENDPOINTS = {
  app: "/auth/pi-flow",
  issuer: "/api/id-jag-playground/issuer/pi-flow",
};

const UNSUPPORTED = "This account needs a step the kit's sign-in cannot show.";
const GENERIC = "Sign-in did not complete. Close this and try again.";

/** The message the dialog shows for a failed start or credentials answer. Never a redirect. */
function messageFor(data) {
  if (data?.fallback || data?.error === "unsupported_state") return UNSUPPORTED;
  if (data?.error === "pi_flow_unavailable") return "PingFederate did not open a sign-in flow; check the PF settings in the README section Sign-in limits.";
  if (data?.error === "not_configured") {
    return `Sign-in is not configured${data.missing?.length ? `: set ${data.missing.join(", ")}` : ""}.`;
  }
  if (typeof data?.message === "string" && data.message) return data.message; // byo_mode and any other 409 from the server
  return GENERIC;
}

/** Sign-in dialog for the pi.flow (no-redirect) login. Answers the idjag:signin event; a failure shows the server's message. */
export default function SignInModal() {
  const appMode = useAppMode();
  const [flow, setFlow] = useState(null); // { kind, returnTo } once the server opened a flow
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(""); // set instead of flow when the sign-in cannot proceed: the dialog shows only this and Close
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const busy = useRef(false);
  const opener = useRef(null);
  const userRef = useRef(null);
  const passRef = useRef(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const gen = useRef(0); // bumped by close(): a response from a cancelled flow is ignored

  const close = () => {
    gen.current += 1; busy.current = false;
    setFlow(null); setNotice(""); setError(""); setUsername(""); setPassword("");
    opener.current?.focus?.();
  };
  const fail = (message) => { setFlow(null); setError(""); setUsername(""); setPassword(""); setNotice(message); };

  useEffect(() => {
    const onSignIn = async (e) => {
      e.detail.handled = true; // claimed even when ignored: a duplicate click is ignored
      if (busy.current) return;
      const { kind, returnTo } = e.detail;
      busy.current = true;
      const g = gen.current;
      opener.current = document.activeElement;
      try {
        const r = await fetch(`${ENDPOINTS[kind]}/start?return_to=${encodeURIComponent(returnTo)}`, { credentials: "include" });
        const data = await r.json().catch(() => null);
        if (g !== gen.current) return;
        if (!r.ok || !data?.flowId) return fail(messageFor(data));
        setFlow({ kind, returnTo });
      } catch {
        if (g === gen.current) fail("Could not reach the server. Close this and try again.");
      } finally {
        if (g === gen.current) busy.current = false;
      }
    };
    window.addEventListener("idjag:signin", onSignIn);
    return () => window.removeEventListener("idjag:signin", onSignIn);
  }, []);

  useEffect(() => { if (flow) userRef.current?.focus(); }, [flow]);
  useEffect(() => { if (notice) closeRef.current?.focus(); }, [notice]);

  // Tab stays inside the dialog, wherever focus currently is. Escape (from anywhere on the page) is FloatingDialog's onClose.
  useEffect(() => {
    if (!flow && !notice) return undefined;
    const onKey = (e) => {
      if (e.key !== "Tab") return undefined;
      const els = dialogRef.current.querySelectorAll("input, button");
      const first = els[0];
      const last = els[els.length - 1];
      const out = !dialogRef.current.contains(document.activeElement);
      if (e.shiftKey && (out || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (out || document.activeElement === last)) { e.preventDefault(); first.focus(); }
      return undefined;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow, notice]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    const g = gen.current;
    const body = JSON.stringify({ username, password });
    setPassword("");
    setError("");
    try {
      const r = await fetch(`${ENDPOINTS[flow.kind]}/credentials`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body,
      });
      const data = await r.json().catch(() => ({}));
      if (g !== gen.current) return;
      if (r.status === 200 && data.redirectTo) return window.location.assign(data.redirectTo);
      if (r.status === 401) { setError(data.message || "Username or password is incorrect."); passRef.current?.focus(); return; }
      if (r.status === 429) { setError("Too many attempts. Wait a few minutes and try again."); return; }
      fail(messageFor(data));
    } catch {
      if (g === gen.current) fail("Could not reach the server. Close this and try again.");
    } finally {
      if (g === gen.current) busy.current = false;
    }
  };

  // The frame is the shared FloatingDialog (movable, resizable, modal). Pop-out is off: the pi.flow form's focus, Tab trap and
  // the relative "Request one" link all belong to this page, so a separate window would break the sign-in.
  const frame = (body) => (
    <FloatingDialog isOpen onClose={close} title="Sign in" closeAriaLabel="Close sign-in" footer={null} disablePopOut
      defaultWidth={400} defaultHeight={null} minHeight={200}>
      <div className="signin-dialog" ref={dialogRef}>{body}</div>
    </FloatingDialog>
  );
  if (notice) {
    return frame(
      <>
        <p className="signin-error" role="alert">{notice}</p>
        <div className="signin-actions">
          <button type="button" className="signin-cancel" ref={closeRef} onClick={close}>Close</button>
        </div>
      </>,
    );
  }
  if (!flow) return null;
  return frame(
    <>
        <form onSubmit={submit}>
          <label htmlFor="signin-user">Username</label>
          <input id="signin-user" ref={userRef} value={username} onChange={(e) => setUsername(e.target.value)}
            autoComplete="username" maxLength={256} required />
          <label htmlFor="signin-pass">Password</label>
          <input id="signin-pass" ref={passRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" maxLength={256} required />
          {error && <p className="signin-error" role="alert">{error}</p>}
          {appMode?.mode === "mock" && appMode.mockUser && (
            <p className="signin-hint" data-testid="signin-mock-hint">
              Mock sign-in, a demo account that exists only inside this app: <code>{appMode.mockUser.username}</code> / <code>{appMode.mockUser.password}</code>
            </p>
          )}
          <div className="signin-actions">
            <button type="button" className="signin-cancel" onClick={close}>Cancel</button>
            <button type="submit" className="signin-submit">Sign in</button>
          </div>
        </form>
        <p className="signin-register">No account? <a href="/register">Request one</a></p>
    </>,
  );
}
