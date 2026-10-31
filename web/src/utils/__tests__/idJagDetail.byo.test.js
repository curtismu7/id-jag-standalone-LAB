import { PLAYGROUND_DIAGRAMS } from "../idJagPlaygroundDiagrams";
import { stepDetail } from "../idJagStepDetail";

const steps = PLAYGROUND_DIAGRAMS.byo.steps.map((s) => s.n);
const SECRETS = [/eyJ/, /[A-Za-z0-9+/=]{40,}/, /[A-Za-z0-9_-]{40,}/];

describe("byo step detail", () => {
  it("has an entry for every step of the diagram", () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const n of steps) expect(stepDetail("byo", n), `step ${n}`).not.toBeNull();
  });

  it("has well-formed forms, tokens and refs", () => {
    for (const n of steps) {
      const d = stepDetail("byo", n);
      expect(d.forms.length).toBeGreaterThan(0);
      for (const f of d.forms) expect(f.title && f.code).toBeTruthy();
      for (const t of d.tokens) {
        expect(typeof t.note).toBe("string");
        expect(typeof t.claims).toBe("object");
      }
      expect(d.refs.length).toBeGreaterThan(0);
      for (const r of d.refs) {
        expect(r.id && r.title).toBeTruthy();
        expect(["rfc", "spec", "emerging"]).toContain(r.kind);
      }
    }
  });

  it("puts no secret-looking text in forms", () => {
    for (const n of steps) {
      for (const f of stepDetail("byo", n).forms) for (const re of SECRETS) expect(f.code, `${n} ${f.title} ${re}`).not.toMatch(re);
    }
  });

  it("attaches standards only to the hops they govern", () => {
    const ids = (n) => stepDetail("byo", n).refs.map((r) => r.id);
    expect(ids(1)).toContain("RFC 8693");
    expect(ids(3)).not.toContain("RFC 8693");
    expect(ids(2)).not.toContain("RFC 8707");
    expect(ids(4).some((id) => id.includes("client-id-metadata-document"))).toBe(false);
  });

  it("shows the PingFederate redeem form with its own client_id and a PF-addressed ID-JAG", () => {
    const d = stepDetail("byo", 3);
    const pf = d.forms.find((f) => f.title.includes("PingFederate"));
    expect(pf.code).toMatch(/client_id=<entry pfClientId/);
    expect(d.tokens.some((t) => /pf\.example/.test(t.claims.aud))).toBe(true);
  });
});
