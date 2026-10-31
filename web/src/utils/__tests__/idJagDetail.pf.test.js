import { PLAYGROUND_DIAGRAMS } from "../idJagPlaygroundDiagrams";
import { stepDetail } from "../idJagStepDetail";

const MODE = "pf-as";
const steps = PLAYGROUND_DIAGRAMS[MODE].steps.map((s) => s.n);
const details = steps.map((n) => [n, stepDetail(MODE, n)]);

describe("pf-as step detail", () => {
  it.each(details)("step %i has forms, tokens and refs", (n, d) => {
    expect(d, `step ${n}`).not.toBeNull();
    expect(d.forms.length).toBeGreaterThan(0);
    expect(d.tokens.length).toBeGreaterThan(0);
    expect(d.refs.length).toBeGreaterThan(0);
  });

  it("covers every step of the diagram, and step 0 has none", () => {
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    expect(stepDetail(MODE, 0)).toBeNull();
  });

  it("every ref has id, title and a known kind", () => {
    for (const [, d] of details) {
      for (const r of d.refs) {
        expect(r.id).toBeTruthy();
        expect(r.title).toBeTruthy();
        expect(["rfc", "spec", "emerging"]).toContain(r.kind);
      }
    }
  });

  it("every token has a note and claims objects", () => {
    for (const [, d] of details) {
      for (const t of d.tokens) {
        expect(typeof t.note).toBe("string");
        expect(t.note).toBeTruthy();
        expect(typeof t.claims).toBe("object");
        expect(Object.keys(t.claims).length).toBeGreaterThan(0);
        if (t.header) expect(typeof t.header).toBe("object");
      }
    }
  });

  it("no form carries a JWT literal or a long base64 blob", () => {
    for (const [, d] of details) {
      for (const f of d.forms) {
        expect(f.title).toBeTruthy();
        expect(f.code).not.toMatch(/eyJ/);
        expect(f.code).not.toMatch(/[A-Za-z0-9+/=]{40,}/);
      }
    }
  });

  it("uses this repo's real parameters for the ID-JAG exchange and redemption", () => {
    const all = (n) => stepDetail(MODE, n).forms.map((f) => f.code).join("\n");
    expect(all(2)).toContain("requested_token_type=urn:ietf:params:oauth:token-type:id-jag");
    expect(all(2)).toContain("/as/token.oauth2");
    expect(all(3)).toContain("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(all(4)).toContain("oauth-protected-resource");
    expect(stepDetail(MODE, 2).tokens[0].header.typ).toBe("oauth-id-jag+jwt");
    expect(stepDetail(MODE, 3).tokens.map((t) => t.header.typ)).toEqual(["oauth-id-jag+jwt", "at+jwt"]);
  });

  it("states the real redeem checks and the sample-vs-spec differences", () => {
    const all = (n) => stepDetail(MODE, n).forms.map((f) => f.code).join("\n");
    expect(all(3)).toContain("400 invalid_request");
    expect(all(3)).not.toMatch(/not both\)\s+-> 401/);
    expect(all(3)).toContain("request at most one resource");
    expect(all(2)).toContain("refresh_token");
    expect(all(2)).toContain("Publish Keys");
    expect(all(4)).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(all(4)).toContain("/protected/profile");
    expect(all(4)).toContain('"check": "scope"');
    expect(all(4)).toContain("/jwks");
  });

  it("does not cite refs that do not govern their hop", () => {
    const ids = (n) => stepDetail(MODE, n).refs.map((r) => r.id);
    expect(ids(2)).not.toContain("RFC 7009");
    expect(ids(4)).not.toContain("draft-ietf-oauth-client-id-metadata-document");
  });
});
