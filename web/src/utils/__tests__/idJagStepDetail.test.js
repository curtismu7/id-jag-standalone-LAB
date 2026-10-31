import { stepDetail } from "../idJagStepDetail";
import { RFC, DRAFT, SPEC, TOKEN_EXCHANGE, IDJAG, MCP_AUTH } from "../idJagStandards";

const { r8693 } = vi.hoisted(() => ({ r8693: { id: "RFC 8693", title: "OAuth 2.0 Token Exchange", kind: "rfc" } }));

vi.mock("../idJagDetail/mock.js", () => ({
  default: {
    2: {
      forms: [{ title: "Exchange", code: "POST /token" }],
      tokens: [{ note: "sample", claims: { sub: "u" } }],
      refs: [r8693, r8693],
    },
    3: { forms: [], tokens: [], refs: [] },
  },
}));
vi.mock("../idJagDetail/pf.js", () => ({ default: { 1: { forms: [{ title: "pf", code: "x" }] } } }));
vi.mock("../idJagDetail/acme.js", () => ({ default: { 1: { refs: [{ id: "s", title: "t", kind: "spec" }] } } }));

describe("stepDetail", () => {
  it("returns forms, tokens and de-duplicated refs for a step with data", () => {
    const d = stepDetail("mock", 2);
    expect(d.forms).toEqual([{ title: "Exchange", code: "POST /token" }]);
    expect(d.tokens).toHaveLength(1);
    expect(d.refs).toEqual([{ id: "RFC 8693", title: "OAuth 2.0 Token Exchange", kind: "rfc" }]);
  });

  it("returns null for a step without data, an empty entry, step 0 or an unknown mode", () => {
    expect(stepDetail("mock", 1)).toBeNull();
    expect(stepDetail("mock", 3)).toBeNull();
    expect(stepDetail("mock", 0)).toBeNull();
    expect(stepDetail("nope", 2)).toBeNull();
  });

  it("fills missing arrays and maps diagram mode ids to the detail files", () => {
    expect(stepDetail("pf-as", 1)).toEqual({ forms: [{ title: "pf", code: "x" }], tokens: [], refs: [] });
    expect(stepDetail("pf", 1)).not.toBeNull();
    expect(stepDetail("pf-pf", 1).refs[0].kind).toBe("spec");
    expect(stepDetail("acme", 1)).not.toBeNull();
  });
});

describe("idJagStandards", () => {
  it("builds entries by kind, with drafts marked emerging", () => {
    expect(RFC(7519, "JWT")).toEqual({ id: "RFC 7519", title: "JWT", kind: "rfc" });
    expect(DRAFT("draft-x", "X").kind).toBe("emerging");
    expect(SPEC("MCP", "M").kind).toBe("spec");
  });

  it("bundles hold the expected entries", () => {
    expect(TOKEN_EXCHANGE.map((r) => r.id)).toEqual(["RFC 8693", "RFC 8707"]);
    expect(IDJAG.every((r) => r.kind === "emerging")).toBe(true);
    expect(MCP_AUTH.map((r) => r.kind)).toEqual(["spec", "rfc", "emerging"]);
  });
});
