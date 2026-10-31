// One ReactFlow diagram per ID-JAG playground mode, as data (ported from AI-DEMO2, adjusted to this
// repo's actors: the playground server, resource-as, mcp-sample; no MCP gateway). The page
// (pages/IdJagPlaygroundDiagramPage.jsx) only draws what is here.
//
// nodes: actors (kind picks the accent colour). notes: gotcha callouts, lit on their steps.
// edges: one real call each. steps = the playground step numbers (1-5) the call belongs to;
// fh/th = card handles (T|B|L|R + 1..3). dashed = where trust comes from (a JWKS or registry
// read) or an alternate path. ambient = lit but not zoomed to (the browser's button presses).
// Step 0 is the overview: everything lit.

export const playgroundDiagramPath = (mode, step) => `/diagram/${mode}${step ? `?step=${step}` : ""}`;

const E = (id, from, fh, to, th, steps, label, dashed = false) => ({ id, from, fh, to, th, steps, label, dashed });
const AMBIENT = (e) => ({ ...e, ambient: true });

const BROWSER = { id: "browser", kind: "user", title: "Browser", sub: "the playground page · session cookie only",
  lines: ["Clicks each step's button", "Sees decoded claims and redacted requests, never a raw token"] };
const SERVER = { id: "server", kind: "bff", title: "Playground server · the OAuth client", sub: "server/ · /api/id-jag-playground",
  lines: ["Holds every token server-side: refresh token, ID-JAG, access token", "Runs a pre-flight check before each button"] };
const RAS = { id: "ras", kind: "as", title: "resource-as · resource AS", sub: "RESOURCE_AS_ISSUER · POST /token",
  lines: ["Trusts an issuer only if its registry read (or TRUSTED_IDPS_FILE) lists it", "Checks typ, signature, aud = its issuer, client_id, jti single-use", "Mints its own at+jwt, aud = the MCP resource"] };
const MCP = { id: "mcp", kind: "rs", title: "mcp-sample · MCP server", sub: "MCP_URL · POST /mcp",
  lines: ["Verifies the token against resource-as /jwks: typ, iss, aud, exp", "tools/list shows only what the scope allows"] };
const PROFILE = { id: "profile", kind: "rs", title: "Protected resource", sub: "GET /protected/profile on mcp-sample",
  lines: ["Same bearer validation as the MCP tools", "Says which check failed when it refuses"] };
const BUTTONS = "POST /api/id-jag-playground/… (cookie only)";
const NEGATIVE = "replay · tampered signature · other client · extra scope";

const STEP_TITLES = ["Sign in", "Get an ID-JAG", "Redeem it", "Call the MCP server", "Negative tests"];
const steps = (texts, titles = STEP_TITLES) => texts.map((text, i) => ({ n: i + 1, t: titles[i], text }));

export const PLAYGROUND_DIAGRAMS = {
  mock: {
    label: "Mock",
    lede: "Same five steps, answered by sample data inside the page. Nothing is sent.",
    overview: "Mock mode needs no sign-in and makes no network call: idJagPlaygroundMock.js stands in for the server and returns the same response shapes, so the page renders exactly as in a real run. Hosts below are sample values.",
    nodes: [
      { ...BROWSER, x: 0, y: 300, sub: "the playground page, in Mock mode", lines: ["Every button calls the mock API, not the network"] },
      { id: "mockapi", kind: "bff", x: 520, y: 300, title: "Mock API", sub: "idJagPlaygroundMock.js · in the page",
        lines: ["Fixtures for issue, inspect, redeem, call, the protected page and negative tests", "Sample trusted IdP: Partner Okta (sample)"] },
      { id: "pf", kind: "pf", x: 1040, y: 0, title: "PingFederate (sample)", sub: "pingfederate.example.com",
        lines: ["Sample ID-JAG typed oauth-id-jag+jwt", "Exchange client agent-exchange-client"] },
      { id: "as", kind: "as", x: 1040, y: 600, title: "MCP authorization server (sample)", sub: "mcp-as.example.com/token",
        lines: ["Sample redemption for client agent-mcp-client"] },
      { ...MCP, x: 1560, y: 300, title: "MCP server (sample)", sub: "mcp.example.com/mcp", lines: ["Sample tools: search_records, get_record, create_note"] },
      { ...PROFILE, x: 520, y: 640, title: "Protected resource (sample)", sub: "sample /protected/profile page" },
    ],
    notes: [
      { id: "n-mock", x: 0, y: 40, steps: [1, 2, 3, 4, 5], text: "Mock: every arrow is simulated by idJagPlaygroundMock.js inside the page. No sign-in, no network, no real token." },
    ],
    edges: [
      AMBIENT(E("m1", "browser", "R2", "mockapi", "L2", [1, 2, 3, 4, 5], "①–⑤ mockApi.post(…) · no network")),
      E("m2", "mockapi", "T3", "pf", "B1", [2, 5], "② simulated RFC 8693 token exchange · requested_token_type=id-jag"),
      E("m3", "mockapi", "R3", "as", "L1", [3], "③ simulated RFC 7523 jwt-bearer · client_id agent-mcp-client"),
      E("m3k", "as", "T2", "pf", "B2", [3], "③ sample JWKS check", true),
      E("m4", "mockapi", "R1", "mcp", "L2", [4], "④ simulated tools/list · tools/call (Bearer)"),
      E("m4r", "mockapi", "B2", "profile", "T2", [4], "④ sample protected page"),
      E("m5", "mockapi", "B3", "as", "L3", [5], `⑤ sample refusals: ${NEGATIVE}`),
    ],
    steps: steps([
      "No sign-in: the mock config says you are signed in, so steps 2 to 5 are ready at once.",
      "A sample ID-JAG comes back with the same request, response and spec-check table a real exchange produces.",
      "A sample redemption returns a decoded access token. The scope dropdown lists the sample ID-JAG's scopes.",
      "tools/list returns three sample tools; tools/call returns a sample result. The protected page renders a sample profile.",
      "Each negative test returns a sample refusal so you can see what a pass looks like.",
    ], ["No sign-in", "Get an ID-JAG", "Redeem it", "Call the MCP server", "Negative tests"]),
  },

  "pf-as": {
    label: "PingFederate → resource AS",
    lede: "PingFederate (PF_URL) issues the ID-JAG; our resource-as redeems it; mcp-sample takes resource-as's token.",
    overview: "PingFederate is the IdP: it issues a short-lived, single-use ID-JAG from your session. resource-as is the MCP server's authorization server: it trusts PingFederate because this server's registry read lists PF_URL, redeems the ID-JAG and mints its own token. Only that token travels on to mcp-sample and the protected page.",
    nodes: [
      { ...BROWSER, x: 0, y: 300 },
      { ...SERVER, x: 520, y: 300 },
      { id: "pf", kind: "pf", x: 1040, y: 0, title: "PingFederate · issues the ID-JAG", sub: "PF_URL · pf.example.invalid",
        lines: ["Sign-in at its own login page (code + PKCE, offline_access)", "Token exchange policy + SP connection with ID-JAG on", "Signs typ oauth-id-jag+jwt · keys at /pf/JWKS (x5t)"] },
      { ...RAS, x: 1040, y: 600 },
      { ...MCP, x: 1560, y: 300 },
      { ...PROFILE, x: 520, y: 640 },
      { id: "registry", kind: "bff", x: 520, y: 1000, title: "Trusted IdPs registry", sub: "server · /api/id-jag-playground/trusted-idps/registry",
        lines: ["Lists PF_URL once pf-as is configured, plus admin-approved outside IdPs", "Read with Bearer ID_JAG_REGISTRY_TOKEN; no secrets in an entry"] },
    ],
    notes: [
      { id: "n-custody", x: 0, y: 600, steps: [1], text: "Custody: the browser never holds a token. The server keeps each one in its session and returns decoded claims and redacted requests only." },
      { id: "n-trust", x: 1560, y: 760, steps: [3], text: "resource-as trusts PingFederate because the server's registry read (Bearer ID_JAG_REGISTRY_TOKEN) lists PF_URL once pf-as is configured. No token set: \"ID-JAG issuer is not trusted\"." },
      { id: "n-stop", x: 1560, y: 560, steps: [4], text: "The ID-JAG stops at resource-as. The MCP call and the protected page carry resource-as's own token; the raw ID-JAG must be refused there." },
      { id: "n-jti", x: 0, y: 900, steps: [5], text: "Each test mints a fresh ID-JAG (② again), breaks one thing and expects an OAuth error with no token. Replay is refused because resource-as keeps jti single-use." },
    ],
    edges: [
      E("a1a", "browser", "T2", "pf", "L1", [1], "① sign-in dialog → /issuer/pi-flow (pi.flow at PingFederate, code + PKCE, prompt=login)"),
      E("a1b", "pf", "L3", "server", "T2", [1], "① code → /issuer/callback · server keeps the refresh token"),
      AMBIENT(E("abtn", "browser", "R2", "server", "L2", [2, 3, 4, 5], `②–⑤ ${BUTTONS}`)),
      E("a2", "server", "T3", "pf", "B1", [2, 5], "② RFC 8693 token exchange · requested_token_type=id-jag · subject=refresh token · audience=RESOURCE_AS_ISSUER"),
      E("a3", "server", "R3", "ras", "L1", [3], "③ RFC 7523 jwt-bearer · client_id RESOURCE_AS_CLIENT_ID · scope ⊆ ID-JAG"),
      E("a3r", "ras", "B1", "registry", "R1", [3], "③ GET /trusted-idps/registry (Bearer ID_JAG_REGISTRY_TOKEN) · lists PF_URL", true),
      E("a3k", "ras", "T2", "pf", "B2", [3], "③ JWKS fetch · PingFederate /pf/JWKS (x5t)", true),
      E("a4", "server", "R1", "mcp", "L2", [4], "④ tools/list · tools/call (Bearer resource-as token)"),
      E("a4k", "mcp", "B2", "ras", "R2", [4], "④ verify vs resource-as /jwks", true),
      E("a4r", "server", "B2", "profile", "T2", [4], "④ GET /protected/profile · token | none | raw ID-JAG"),
      E("a5", "server", "B3", "ras", "L3", [5], `⑤ broken assertions: ${NEGATIVE}`),
    ],
    steps: steps([
      "A fresh sign-in at PingFederate's own login page. The server swaps the code for tokens and keeps the refresh token: the ID-JAG is minted from it.",
      "RFC 8693 token exchange at PingFederate with requested_token_type=…:id-jag. subject_token is the refresh token, audience is resource-as's issuer, resource is the MCP server. PingFederate returns a JWT typed oauth-id-jag+jwt that lives about 5 minutes; the page checks it against the draft.",
      "RFC 7523 JWT bearer grant at resource-as. It finds PingFederate on the registry it reads from this server, fetches its keys, checks typ, signature, iss, a single aud equal to its issuer, expiry, that client_id is the client redeeming now, and that the jti is unused. It grants at most the ID-JAG's scope and mints its own access token.",
      "tools/list and tools/call go straight to mcp-sample with resource-as's token. mcp-sample verifies it against resource-as's JWKS (typ at+jwt, iss, aud, exp) and lists only what the scope allows. Its /protected/profile takes the same token and must refuse no token and the raw ID-JAG.",
      "Each test mints a fresh ID-JAG, breaks one thing (replay, signature, client, scope) and expects an OAuth error with no token.",
    ], ["Sign in at PingFederate", "Get an ID-JAG from PingFederate", "Redeem at resource-as", "Call mcp-sample", "Negative tests"]),
  },

  "pf-pf": {
    label: "Acme PingFederate → PingFederate",
    lede: "The outside Acme PingFederate issues the ID-JAG; our PingFederate (PF_URL) redeems it through an IdP connection.",
    overview: "Two PingFederates: Acme is an outside company's IdP and issues the ID-JAG after a sign-in at its own login page; ours is the resource authorization server and redeems it with a JWT bearer grant through an IdP connection. mcp-sample trusts resource-as's tokens only, so step 4 shows a refusal here.",
    nodes: [
      { ...BROWSER, x: 0, y: 300 },
      { ...SERVER, x: 520, y: 300 },
      { id: "acme", kind: "pf", x: 1040, y: 0, title: "Acme PingFederate · issuer", sub: "ACME_PF_URL · pf-acme.example.invalid",
        lines: ["Its own login page (code + PKCE, offline_access)", "Token exchange policy issues the ID-JAG, aud = PF_URL", "Signs with the key published at /pf/JWKS"] },
      { id: "ourpf", kind: "as", x: 1040, y: 600, title: "Our PingFederate · resource AS", sub: "PF_URL · /as/token.oauth2",
        lines: ["JWT bearer grant through an IdP connection to Acme", "Client PF_REDEEMER_CLIENT_ID (id-jag-redeemer)", "Mints from its access token manager"] },
      { ...MCP, x: 1560, y: 300 },
      { ...PROFILE, x: 520, y: 640 },
    ],
    notes: [
      { id: "n-two", x: 520, y: -200, steps: [1, 2], text: "Two PingFederates on purpose: an IdP must not redeem its own ID-JAG (draft §9.3)." },
      { id: "n-x5t", x: 1040, y: 880, steps: [3], text: "Gotcha: PingFederate cannot pick a key by x5t. Acme must publish a single-key JWKS, and our PingFederate caches it: re-save the IdP connection (or restart it) after a key change, or redeem fails with \"Invalid JWT token\"." },
      { id: "n-iss", x: 1560, y: 600, steps: [4], text: "Our PingFederate minted this access token, and mcp-sample trusts resource-as only, so the MCP call and the protected page refuse it and say which check failed. PingFederate → resource AS shows them accepted." },
    ],
    edges: [
      E("p1a", "browser", "T2", "acme", "L1", [1], "① sign-in dialog → /issuer/pi-flow (pi.flow at Acme, code + PKCE, prompt=login)"),
      E("p1b", "acme", "L3", "server", "T2", [1], "① code → /issuer/callback · server keeps the Acme refresh token"),
      AMBIENT(E("pbtn", "browser", "R2", "server", "L2", [2, 3, 4, 5], `②–⑤ ${BUTTONS}`)),
      E("p2", "server", "T3", "acme", "B1", [2, 5], "② RFC 8693 token exchange · requested_token_type=id-jag · audience=PF_URL"),
      E("p3", "server", "R3", "ourpf", "L1", [3], "③ RFC 7523 jwt-bearer · client_id PF_REDEEMER_CLIENT_ID"),
      E("p3k", "ourpf", "T2", "acme", "B2", [3], "③ IdP connection fetches Acme's /pf/JWKS (single key)", true),
      E("p4", "server", "R1", "mcp", "L2", [4], "④ tools/list · tools/call (Bearer PingFederate token) → refused"),
      E("p4r", "server", "B2", "profile", "T2", [4], "④ GET /protected/profile → refused, names the failed check"),
      E("p5", "server", "B3", "ourpf", "L3", [5], `⑤ broken assertions: ${NEGATIVE}`),
    ],
    steps: steps([
      "A sign-in at the Acme PingFederate's own login page, separate from this app's sign-in. The server runs code + PKCE against Acme and keeps its refresh token.",
      "RFC 8693 token exchange at Acme with requested_token_type=…:id-jag, subject = the Acme refresh token, audience = our PingFederate's issuer (PF_URL).",
      "RFC 7523 JWT bearer grant at our PingFederate as PF_REDEEMER_CLIENT_ID. Its IdP connection to Acme verifies the signature with Acme's JWKS, then its access token manager mints the access token.",
      "tools/list and the protected page go to mcp-sample with our PingFederate's token. mcp-sample trusts resource-as's tokens only, so it refuses and names the failed check: the expected outcome in this mode.",
      "Each test mints a fresh ID-JAG at Acme, breaks one thing and expects our PingFederate to refuse it with no token.",
    ], ["Sign in at Acme", "Get an ID-JAG from Acme", "Redeem at our PingFederate", "Call mcp-sample (refused)", "Negative tests"]),
  },

  byo: {
    label: "Your IdP → our resource AS",
    lede: "An outside IdP issues the ID-JAG; resource-as or our PingFederate redeems it because the Trusted IdPs registry says so.",
    overview: "An outside agent signs its user in at its own IdP and gets an ID-JAG addressed to our authorization server. You paste it here, or tools/outside-agent.js presents it directly. Or click \"Get an ID-JAG from xaa.dev\": IdenX, the IdP of Okta's free xaa.dev playground, signs you in and issues one to this server. Our authorization server only trusts an outside IdP because an admin approved it on the Trusted IdPs registry.",
    nodes: [
      { id: "agent", kind: "user", x: 0, y: 0, title: "Outside agent", sub: "tools/outside-agent.js · or you",
        lines: ["Signs its user in at its own IdP", "Gets an ID-JAG addressed to our authorization server"] },
      { id: "extidp", kind: "pf", x: 1040, y: 0, title: "Outside IdP · issues", sub: "e.g. Acme PingFederate, Okta",
        lines: ["Token exchange → ID-JAG, aud = our AS issuer", "client_id = the one it registered for us", "Publishes its own JWKS"] },
      { id: "idenx", kind: "pf", x: 520, y: -560, title: "xaa.dev IdenX · free outside IdP", sub: "idp.xaa.dev · Okta's public Cross App Access playground",
        lines: ["Any email signs in (cap it to read)", "Token exchange → ID-JAG, aud = resource-as's public issuer", "Approved Trusted IdP · keys at idp.xaa.dev/jwks"] },
      { ...BROWSER, x: 0, y: 340, title: "Browser · paste or xaa.dev", lines: ["Pastes the ID-JAG once, or clicks Get an ID-JAG from xaa.dev", "Sees decoded claims only"] },
      { ...SERVER, x: 520, y: 340 },
      { ...RAS, x: 1040, y: 680, sub: "target resource-as · RESOURCE_AS_ISSUER/token" },
      { id: "ourpf", kind: "as", x: 1040, y: 1000, title: "Our PingFederate · resource AS", sub: "target pingfederate · PF_URL",
        lines: ["JWT bearer via an IdP connection synced from the registry", "Client PF_REDEEMER_CLIENT_ID"] },
      { id: "registry", kind: "bff", x: 520, y: 1000, title: "Trusted IdPs registry", sub: "server · /api/id-jag-playground/trusted-idps",
        lines: ["Admin-approved: issuer, JWKS URL, client_id the IdP writes, targets, scope cap", "No secrets in an entry"] },
      { ...MCP, x: 1560, y: 340 },
      { ...PROFILE, x: 0, y: 680 },
    ],
    notes: [
      { id: "n-trust", x: 0, y: 1000, steps: [2, 3], text: "Trust comes from the Trusted IdPs registry: an admin approves the issuer, its JWKS URL, the client_id it writes and the targets. An issuer not on the list (or not for this target) is refused before any redemption." },
      { id: "n-agent", x: 0, y: -180, steps: [1], text: "tools/outside-agent.js runs the same flow with none of our code in its path: its IdP, then our public token endpoint, then (optionally) the MCP server." },
      { id: "n-replay", x: 1560, y: 1000, steps: [5], text: "Replay is skipped: it would use up your ID-JAG. The other tests reuse your pasted token, broken one way at a time." },
    ],
    edges: [
      E("b1a", "agent", "R2", "extidp", "L2", [1], "① sign in + RFC 8693 token exchange · requested_token_type=id-jag · aud=our AS issuer"),
      E("b1p", "agent", "B2", "browser", "T2", [1], "① paste the ID-JAG (compact JWT)"),
      E("b1b", "browser", "R1", "server", "L1", [1], "① POST /byo/inspect · { idJag, target }"),
      E("bx1", "browser", "R2", "idenx", "L2", [1], "① or: /xaa/login → IdenX sign-in (PKCE)"),
      E("bx2", "idenx", "B1", "server", "T1", [1], "① code → /xaa/callback"),
      E("bx3", "server", "T3", "idenx", "R3", [1], "① /xaa/id-jag: RFC 8693 → ID-JAG"),
      AMBIENT(E("bbtn", "browser", "R3", "server", "L3", [3, 4, 5], `③–⑤ ${BUTTONS}`)),
      E("b2r", "server", "B2", "registry", "T2", [2], "② iss on the Trusted IdPs list for this target?"),
      E("b2k", "server", "T2", "extidp", "L3", [2], "② JWKS fetch · verify the signature", true),
      E("b3", "server", "R3", "ras", "L1", [3], "③ RFC 7523 jwt-bearer · client_id from the registry entry (default RESOURCE_AS_CLIENT_ID)"),
      E("b3p", "server", "B3", "ourpf", "L1", [3], "③ or target=pingfederate · client_id PF_REDEEMER_CLIENT_ID"),
      E("b3r", "ras", "B1", "registry", "R1", [3], "③ GET /trusted-idps/registry (Bearer ID_JAG_REGISTRY_TOKEN)", true),
      E("b3s", "ourpf", "L3", "registry", "R3", [3], "③ pingfederate/sync-id-jag-trusted-idps.js → IdP connection", true),
      E("b3k", "ras", "T2", "extidp", "B2", [3], "③ JWKS fetch · the outside IdP's keys", true),
      E("b4", "server", "R1", "mcp", "L2", [4], "④ tools/list · tools/call (Bearer resource-as token)"),
      E("b4k", "mcp", "B2", "ras", "R2", [4], "④ verify vs resource-as /jwks", true),
      E("b4r", "server", "B1", "profile", "R1", [4], "④ GET /protected/profile"),
      E("b5", "server", "R2", "ras", "L3", [5], "⑤ your ID-JAG, broken one way at a time (replay skipped)"),
    ],
    steps: steps([
      "Your IdP signs its user in and issues the ID-JAG (aud = our authorization server's issuer). You paste it; the server keeps it and shows only its decoded claims. Or use xaa.dev: this server signs you in at IdenX (code + PKCE), exchanges IdenX's refresh token for an ID-JAG addressed to resource-as's public issuer, and loads it the same way.",
      "The server finds the issuer on the Trusted IdPs registry (enabled, and targeting the server you picked), verifies the signature with that IdP's JWKS, and runs the draft checks.",
      "RFC 7523 JWT bearer grant at resource-as (client from the registry entry) or at our PingFederate (PF_REDEEMER_CLIENT_ID). resource-as reads the registry from this server; PingFederate gets it as an IdP connection from the sync script. Either one verifies against the outside IdP's keys and mints its own token. For IdenX: keys at idp.xaa.dev/jwks, and its client_id must be the one its entry maps to idp-<id>.",
      "tools/list and tools/call go straight to mcp-sample with resource-as's token; mcp-sample verifies it against resource-as's JWKS. The protected page takes the same token. (A token from our PingFederate is refused there: mcp-sample trusts resource-as only.)",
      "We cannot mint at your IdP, so each test reuses your pasted ID-JAG and breaks one thing. Replay is skipped.",
    ], ["Paste an ID-JAG, or get one from xaa.dev", "Check it against the draft", "Redeem at our resource AS", "Call mcp-sample", "Negative tests"]),
  },
};

export const PLAYGROUND_DIAGRAM_MODES = Object.keys(PLAYGROUND_DIAGRAMS);

const ends = (edges) => [...new Set(edges.flatMap((e) => [e.from, e.to]))];

/**
 * What step `step` lights up: its calls, the actors they touch and its callouts. `focus` is what the
 * view zooms to (ambient calls left out, unless the step has nothing else). Step 0 lights everything.
 */
export function stepParts(d, step) {
  if (!step) {
    const nodes = d.nodes.map((n) => n.id);
    return { edges: d.edges.map((e) => e.id), nodes, notes: d.notes.map((n) => n.id), focus: nodes };
  }
  const edges = d.edges.filter((e) => e.steps.includes(step));
  const notes = d.notes.filter((n) => n.steps.includes(step)).map((n) => n.id);
  const main = ends(edges.filter((e) => !e.ambient));
  return { edges: edges.map((e) => e.id), nodes: ends(edges), notes, focus: [...(main.length ? main : ends(edges)), ...notes] };
}

/** The step number an edge's badge shows: the first step it belongs to. */
export const edgeStepNumber = (e) => Math.min(...e.steps);

/** Does `step` light this actor or callout? */
export const stepLights = (d, step, id) => {
  const p = stepParts(d, step);
  return p.nodes.includes(id) || p.notes.includes(id);
};

/** First step (1..n) that lights the actor or callout, or 0 when none does. */
export const firstStepLighting = (d, id) => d.steps.find((s) => stepLights(d, s.n, id))?.n ?? 0;

/** The actor a step centres on: the first actor (not callout) it zooms to. */
export const focusNode = (d, step) => stepParts(d, step).focus.find((id) => d.nodes.some((n) => n.id === id)) ?? null;
