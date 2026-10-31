import { mcpcCommand, vscodeMcpJson, vscodeSettings } from "../realClients";

const PF = "https://pf.test";
const MCP = "http://localhost:4722/mcp";

describe("real client snippets", () => {
  it("points mcpc at our PingFederate and MCP server", () => {
    const cmd = mcpcCommand({ pfUrl: PF, mcpUrl: MCP });
    expect(cmd).toContain(`login ${MCP} --grant id-jag`);
    expect(cmd).toContain(`--idp ${PF} --idp-client-id id-jag-mcpc`);
    expect(cmd).toContain("@apify/mcpc@0.7.0");
    expect(cmd).toContain(`connect ${MCP} @kit`);
  });

  it("gives VS Code our issuer and the MCP server", () => {
    expect(vscodeSettings({ pfUrl: PF })).toContain(`"issuer": "${PF}"`);
    expect(vscodeMcpJson({ mcpUrl: MCP })).toContain(`"url": "${MCP}"`);
    expect(vscodeMcpJson({ mcpUrl: MCP })).toContain('"enterpriseManaged": true');
  });

  it("only ever shows secret placeholders", () => {
    const all = [mcpcCommand({ pfUrl: PF, mcpUrl: MCP }), vscodeSettings({ pfUrl: PF }), vscodeMcpJson({ mcpUrl: MCP })].join("\n");
    const secrets = all.match(/secret"?[ :=]+"?[^\s",]+/gi) || [];
    for (const s of secrets) expect(s).toMatch(/\$[A-Z_]+|<[A-Z_]+>/);
  });
});
