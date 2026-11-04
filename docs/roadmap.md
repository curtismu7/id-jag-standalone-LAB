# Roadmap

The build phases this kit was made in, kept for history. The README describes what works today.

- **Phase 1, skeleton and extraction:** web + server workspaces, Mock mode, inspector, trusted-IdP
  registry, Docker, CI.
- **Phase 2:** our own resource AS (redeems ID-JAGs, trusts the registry) and an MCP sample server, so
  `pf-as`, byo → resource AS and step 4 (call the MCP server) work.
- **Phase 3A:** real modes wired to `resource-as` and `mcp-sample`, protected-resource page,
  pre-flight checks, lifetime clocks, scope list, Results panel, per-mode diagrams, run report, compose
  for all three services.
- **Phase 3B:** PingFederate pi.flow sign-in at `/auth/pi-flow` (which also grants admin for the Trusted IdPs
  registry), IdP self-registration, audit log. The playground reads the signed-in user's issuer token only
  through `getIssuerSubjectToken(req, mode)` (`server/src/issuerSession.js`).
- **Phase 3, rest:** done. The real `pf-pf` setup (`npm run setup -- --mode=pf-pf --acme-settings=<file>`, the owner's
  [runbook](acme-owner-runbook.md)) and `pingfederate/sync-id-jag-trusted-idps.js` and `configure-kid-workaround.js`
  adapted to the kit's own PingFederate. Not done: `configure-acme-idp.js` still describes the demo's Acme setup and must never be run against the shared one.
- **Phase 4:** packaging, CI hardening, SE deployment.
- **Phase 5, planned:** the AWS AgentCore leg's live form. The mock-only leg shipped in this kit simulates the runtime
  (see the README's "AWS AgentCore leg"); the planned live leg is: real legs 1–2 (the user's PingFederate issues the
  ID-JAG from the pf-as issuer session; the kit's resource-as redeems it) and a real Bedrock AgentCore runtime, deployed
  owner-run (IAM execution role, region-pinned), with the runtime hop refusing with 409 until that runtime exists.
