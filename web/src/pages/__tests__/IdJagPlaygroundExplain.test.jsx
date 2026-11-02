// The plain-language hint under an OAuth error. In the app's Mock mode there are no RESOURCE_AS_CLIENT_* settings to blame.
import { explain } from "../IdJagPlaygroundPage";

const refused = { error: "invalid_client", message: "client authentication failed" };

describe("explain: invalid_client", () => {
  it("in Mock mode it does not blame RESOURCE_AS_CLIENT_ID or SECRET, and says what the mock accepts", () => {
    const hint = explain(refused, "https://mcp.mock.invalid/mcp", false, true);
    expect(hint).toMatch(/mock authorization server/i);
    expect(hint).toMatch(/Mock mode has no RESOURCE_AS_CLIENT_ID or RESOURCE_AS_CLIENT_SECRET to set/);
    expect(hint).toMatch(/idp-<id>/);
    expect(hint).toMatch(/each approved Trusted IdP/);
    expect(hint).not.toMatch(/leave/i); // the idp-<id> client is provisioned on approval: there is no blank field to leave
  });

  it("in Live mode it still points at the real settings", () => {
    const hint = explain(refused, "http://localhost:9090/mcp", false, false);
    expect(hint).toMatch(/RESOURCE_AS_CLIENT_ID and RESOURCE_AS_CLIENT_SECRET/);
    expect(explain(refused, "x")).toBe(hint);
  });

  it("other errors read the same in both modes", () => {
    const e = { error: "invalid_grant", message: "ID-JAG expired" };
    expect(explain(e, "x", false, true)).toBe(explain(e, "x", false, false));
  });
});
