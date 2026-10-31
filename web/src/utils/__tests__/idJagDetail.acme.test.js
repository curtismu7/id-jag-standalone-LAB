import { PLAYGROUND_DIAGRAMS } from "../idJagPlaygroundDiagrams";
import { stepDetail } from "../idJagStepDetail";

const steps = PLAYGROUND_DIAGRAMS["pf-pf"].steps.map((s) => s.n);

describe("acme step detail (pf-pf)", () => {
  it("has an entry for every step of the diagram", () => {
    for (const n of steps) expect(stepDetail("pf-pf", n), `step ${n}`).not.toBeNull();
    expect(stepDetail("acme", 1)).toEqual(stepDetail("pf-pf", 1));
  });

  it("gives every step forms and refs, with well-formed tokens", () => {
    for (const n of steps) {
      const d = stepDetail("pf-pf", n);
      expect(d.forms.length, `forms ${n}`).toBeGreaterThan(0);
      expect(d.refs.length, `refs ${n}`).toBeGreaterThan(0);
      for (const f of d.forms) expect(f.title && f.code).toBeTruthy();
      for (const t of d.tokens) {
        expect(typeof t.note).toBe("string");
        expect(t.claims && typeof t.claims).toBe("object");
        if (t.header) expect(typeof t.header).toBe("object");
      }
    }
  });

  it("has refs with id, title and a known kind", () => {
    for (const n of steps) {
      for (const r of stepDetail("pf-pf", n).refs) {
        expect(r.id && r.title).toBeTruthy();
        expect(["rfc", "spec", "emerging"]).toContain(r.kind);
      }
    }
  });

  it("shows the ID-JAG header typ and claims in the steps that carry one", () => {
    for (const n of [2, 3, 5]) {
      const t = stepDetail("pf-pf", n).tokens.find((x) => x.header?.typ === "oauth-id-jag+jwt");
      expect(t, `step ${n}`).toBeTruthy();
      for (const k of ["iss", "sub", "aud", "client_id", "jti", "exp", "iat", "resource", "scope"]) expect(t.claims[k], k).toBeDefined();
    }
    expect(stepDetail("pf-pf", 3).tokens).toHaveLength(2);
  });

  it("puts no secret-looking material in any form or token", () => {
    for (const n of steps) {
      const d = stepDetail("pf-pf", n);
      const text = JSON.stringify([d.forms, d.tokens]);
      expect(text).not.toMatch(/eyJ/);
      expect(text).not.toMatch(/[A-Za-z0-9+/_-]{40,}={0,2}/);
    }
  });

  it("keeps the step 4 access token consistent with the refusal shown (typ at+jwt, fails at signature)", () => {
    const d = stepDetail("pf-pf", 4);
    expect(d.tokens[0].header.typ).toBe("at+jwt");
    expect(d.forms.find((f) => f.title.startsWith("Refusal")).code).toContain('"check": "signature"');
  });
});
