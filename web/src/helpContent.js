// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: "A playground for ID-JAG (Identity Assertion JWT Authorization Grant), an IETF draft, so details can still change. It runs the flow one step at a time — get an ID-JAG from an IdP (RFC 8693 token exchange), redeem it at a resource authorization server (RFC 7523 JWT bearer), call an MCP server with the result — and shows every request, token and check. Among Ping products only PingFederate supports ID-JAG, which is why the live modes need PingFederate."
  },
  {
    heading: "What is measured vs UNVERIFIED",
    body: [
      "Measured here: the mock flow's cryptography is real (ES256 signatures, real JWT checks) but the keys belong to the simulation; every mock token carries \"mock\": true and a kid starting with mock-. The live PingFederate topologies (pf-as against a local PingFederate, pf-pf against an SE server) were tested end to end in a real browser on 2026-11-04.",
      "UNVERIFIED: the Gateway redeem page demonstrates a Ping release claim (2026-11-02) that is NOT on our tenant — everything there runs against in-process mocks and a banner on every page says so. The AgentCore leg is a lab simulation of the AWS side; no AWS service is called. A mock token proves how the flow works; it proves nothing about a customer's PingFederate."
    ]
  },
  {
    heading: "How to use the page",
    body: [
      "The top bar links: Playground, Trusted IdPs, Setup guides, Inspector, CIMD tester, Learn (admins also see Account requests), plus the IETF draft link, Sign in / Sign out, and Present for presenter mode.",
      "On the Playground, pick a mode: Sample data (browser), PingFederate → resource AS, Acme PingFederate → PingFederate, Your IdP → our resource AS, Gateway redeems the ID-JAG (mock only), or ID-JAG → mock AgentCore runtime (mock only). Toggle Form | JSON, choose OIDC | SAML, and press Issue, Redeem and Call. Each step has tabs: Request · Response · Decoded · Code, with a pre-flight check that blocks sending while it fails. Download report saves the run as Markdown or JSON, with no raw token in it.",
      "The Inspector (/inspect) decodes any pasted token or gets one for you (Show token reveals your own session's ID-JAG). Learn holds the in-app docs and a searchable glossary. Trusted IdPs lists outside IdPs; new entries stay pending until an admin approves them."
    ]
  },
  {
    heading: "Mock vs Live",
    body: "The Mock / Live switch in the header chooses what the app talks to; a banner on every page repeats it. Mock needs no tenant and no settings. Live needs PF_URL and the exchange client configured — the banner names what is missing if it is not. Gateway redeem and AgentCore have no Live form. Switching ends every session, and real tokens never reach the browser: the server keeps them and returns decoded claims only."
  },
  {
    heading: "Diagrams and diagnostics",
    body: "Each mode has a ReactFlow diagram at /diagram/<mode> (?step=N lights one step) with Simulate, Speed and Reset controls. npm run doctor checks your setup before a demo; the resource AS shows its last 50 redemptions on its own page."
  }
];
