import { useEffect, useState } from "react";

/**
 * Other people's resource authorization servers: what docs/interop-lab.md recorded for each, and a Run button that
 * mints a fresh ID-JAG at PingFederate for that target and redeems it there. The server does both; no token comes back.
 * Only meaningful for "PingFederate to resource AS" (the signed-in session is the subject).
 */
export default function InteropPanel({ client, base }) {
  const [targets, setTargets] = useState(null);
  const [runs, setRuns] = useState({}); // id -> { busy } | { result } | { error }

  useEffect(() => {
    let live = true;
    client.get(`${base}/interop`).then((r) => live && setTargets(r.data?.targets || [])).catch(() => live && setTargets([]));
    return () => { live = false; };
  }, [client, base]);

  const run = async (t) => {
    setRuns((r) => ({ ...r, [t.id]: { busy: true } }));
    try {
      const r = await client.post(`${base}/interop/${t.id}/run`);
      setRuns((s) => ({ ...s, [t.id]: { result: r.data } }));
    } catch (err) {
      setRuns((s) => ({ ...s, [t.id]: { error: err.response?.data?.message || (err.response?.data?.missing ? `Set ${err.response.data.missing.join(", ")}` : err.message) } }));
    }
  };

  if (!targets?.length) return null;
  return (
    <details className="ijp-interop" data-testid="ijp-interop" data-admin-only="">
      <summary>Interop: other resource servers</summary>
      <p className="ijp-note">Does a PingFederate ID-JAG work at someone else's resource AS? "Recorded" is what we found on 2026-10-19 (docs/interop-lab.md); Run asks again now.</p>
      <table>
        <thead><tr><th>Target</th><th>Recorded</th><th>Now</th><th /></tr></thead>
        <tbody>
          {targets.map((t) => {
            const r = runs[t.id] || {};
            const d = r.result;
            return (
              <tr key={t.id} data-testid={`ijp-interop-${t.id}`}>
                <th scope="row">{t.name}
                  <span className="ijp-note">{t.method === "kid" ? "Workaround: token exchange answered by a JWT access token manager (kid in the header). Not a native ID-JAG." : "Native ID-JAG from PingFederate (x5t, no kid)"}</span>
                  <span className="ijp-note">{t.audience}</span></th>
                <td><span className={`ijp-pill ${t.recorded.result === "accepts" ? "is-ok" : "is-bad"}`}>{t.recorded.result}</span><span className="ijp-note">{t.recorded.note}</span></td>
                <td aria-live="polite">
                  {r.busy && "Running…"}
                  {r.error && <span className="ijp-note">{r.error}</span>}
                  {d?.mint?.error && <span className="ijp-note">PingFederate refused the exchange: {d.mint.error}{d.mint.error_description ? ` (${d.mint.error_description})` : ""}. {d.mint.hint}</span>}
                  {d?.redeem && (
                    <>
                      <span className={`ijp-pill ${d.redeem.accepted ? "is-ok" : "is-bad"}`}>{d.redeem.accepted ? "accepted" : "refused"}</span>
                      <span className="ijp-note">
                        header kid: {d.mint.header.kid ? "yes" : "no"}, x5t: {d.mint.header.x5t ? "yes" : "no"}
                        {d.redeem.error ? `. ${d.redeem.error}: ${d.redeem.error_description || ""}` : ""}
                      </span>
                    </>
                  )}
                </td>
                <td>
                  <button type="button" className="ijp-btn" onClick={() => run(t)} disabled={r.busy || t.missing.length > 0}
                    title={t.missing.length ? `Set ${t.missing.join(", ")} on the server` : undefined}>Run</button>
                  {t.missing.length > 0 && <span className="ijp-note">needs {t.missing[0].replace(/_(CLIENT_)?(ID|SECRET)$/, "")}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
