import terms from "../data/terms.json";
import sources from "../data/sources.json";

const SLUG = /^[a-z0-9-]+$/;
const STATUSES = new Set(["verified", "read", "search-only", "not-read"]);

describe("Learn data", () => {
  it.each([["terms", terms], ["sources", sources]])("%s: ids are unique slugs", (_, list) => {
    const ids = list.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(SLUG);
  });

  it("every term has a name and a definition", () => {
    for (const t of terms) {
      expect(t.term, t.id).toBeTruthy();
      expect(t.definition.length, t.id).toBeGreaterThan(40);
    }
  });

  it("has the terms the playground steps and the Learn page link to", () => {
    expect(terms.length).toBeGreaterThanOrEqual(18);
    const ids = new Set(terms.map((t) => t.id));
    for (const id of ["identity-assertion", "requesting-app", "id-jag", "token-exchange", "resource-authorization-server", "jwt-bearer-grant",
      "jti-replay", "strict-client-binding", "resource-server", "refresh-token-revocation", "dpop", "cimd"]) expect(ids.has(id), id).toBe(true);
    expect(terms.find((t) => t.id === "jti-replay").term).toBe("jti replay protection");
  });

  it("every source is an https link with a kind, a use, a status and a check date", () => {
    expect(sources.length).toBeGreaterThanOrEqual(30);
    for (const s of sources) {
      expect(s.url, s.id).toMatch(/^https:\/\//);
      expect(s.kind && s.use && s.title, s.id).toBeTruthy();
      expect(STATUSES.has(s.status), `${s.id}: ${s.status}`).toBe(true);
      expect(s.checked, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("leaves out Okta- and Auth0-built samples", () => {
    for (const s of sources) expect(s.url, s.id).not.toMatch(/github\.com\/(oktadev|okta-samples|auth0-samples)\//);
  });
});
