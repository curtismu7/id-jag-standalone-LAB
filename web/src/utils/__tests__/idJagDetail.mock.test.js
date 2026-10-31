import { PLAYGROUND_DIAGRAMS } from "../idJagPlaygroundDiagrams";
import { stepDetail } from "../idJagStepDetail";

const steps = PLAYGROUND_DIAGRAMS.mock.steps.map((s) => s.n);

describe("mock mode step detail", () => {
  it("has an entry for every step, with forms, tokens (possibly empty) and refs", () => {
    for (const n of steps) {
      const d = stepDetail("mock", n);
      expect(d, `step ${n}`).not.toBeNull();
      expect(d.forms.length, `step ${n} forms`).toBeGreaterThan(0);
      expect(d.refs.length, `step ${n} refs`).toBeGreaterThan(0);
    }
  });

  it("gives every ref an id, title and a known kind", () => {
    for (const n of steps) for (const r of stepDetail("mock", n).refs) {
      expect(r.id && r.title).toBeTruthy();
      expect(["rfc", "spec", "emerging"]).toContain(r.kind);
    }
  });

  it("gives every token a note and claims, and the ID-JAG its typ", () => {
    for (const n of steps) for (const t of stepDetail("mock", n).tokens) {
      expect(typeof t.note).toBe("string");
      expect(t.claims && typeof t.claims).toBe("object");
    }
    const jag = stepDetail("mock", 2).tokens[0];
    expect(jag.header.typ).toBe("oauth-id-jag+jwt");
    expect(Object.keys(jag.claims)).toEqual(expect.arrayContaining(["iss", "sub", "aud", "client_id", "jti", "exp", "iat", "resource", "scope"]));
    expect(stepDetail("mock", 3).tokens.map((t) => t.header.typ)).toEqual(["oauth-id-jag+jwt", "at+jwt"]);
  });

  it("contains no JWT literal or long opaque base64 string in any form or token", () => {
    for (const n of steps) {
      const d = stepDetail("mock", n);
      const text = [...d.forms.map((f) => f.code), ...d.tokens.map((t) => JSON.stringify(t))].join("\n");
      expect(text).not.toMatch(/eyJ/);
      expect(text).not.toMatch(/[A-Za-z0-9+/_-]{40,}={0,2}/);
    }
  });
});
