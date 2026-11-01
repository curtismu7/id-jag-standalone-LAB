# ID-JAG Standalone LAB

Token exchange with ID-JAG, using a mock authorization server and a sample MCP server. Tier: Demo. Catalog: C1.

## Run and test

```sh
npm ci
npm test                # web, server, resource-as, mcp-sample and script tests
npm run build           # builds the web app
npm start               # http://localhost:4720
npm run doctor          # checks Node, settings and /api/health
npm run reset           # clears run state
npm run check:forbidden # forbidden-strings, UUID and private-host scan
```

Docker: `docker compose -f deploy/docker-compose.yml up --build -d` (publishes 127.0.0.1 only).

## Ports

Server 4720, resource-as 4721, mcp-sample 4722, Vite dev server 4723. Block 4720-4729. Never 8080, 5173 or 18080/19080/19090.

## Mock and live

`MODE=mock|live`, default mock unless the live `PF_*` settings are set, then live (`server/src/mode.js`; the toggle's choice is saved in `DATA_DIR/mode.json`). Mock = the in-process
PingFederate, Acme PingFederate, resource AS and MCP server in `server/src/mock/`, reached only through `server/src/netguard.js` (no other
module may call `fetch`; use `outboundFetch`). Settings are read through `runtimeEnv()`, never `process.env`, so mock mode cannot see real
settings. Mock tokens carry `mock: true`; EC keys use `createECDH` + `createPrivateKey`. Mock sign-in is guarded (`mockSignin.js`).
The server suite runs with `MODE=live` (vitest config); `mock*.test.js` choose mock themselves.

## Diagrams, stories, talk track

- Diagrams are diagram-studio/1 data files in `diagrams/` (one per playground mode: `mock`, `pf-as`, `pf-pf`, `byo`, `gateway-redeem`), loaded by name
  (`web/src/diagrams/loadDiagram.js`) and turned into the page's model by `playgroundModel.js`. Do not hand-build nodes or edges. Edit the
  JSON (box positions, arrows, steps; a step's `why` is its gotcha callout). Arrow handles are chosen from box positions, and a test fails
  when two arrows share a slot or run. The Dockerfile copies `diagrams/` into the web build.
- After any diagram change, run the overlap check in a real browser: evaluate `AI-DEMO-Standalone/scripts/diagram-overlap.js` on `/diagram/<mode>`
  (and `?step=1` to `5`) and expect `pass: true` with no lit label clipped.
- Stories (`web/src/data/stories`) name people only as `{{cast.<id>}}` and nouns as `{{vocab.<key>}}`. Names come from the vertical pack and
  from `customer.config.json` `persona`. A test fails on an undefined token or a written-out cast name.
- `docs/talk-track.md` is the presenter script. A test checks that every bold button name in it still exists in `web/src`.

## Gateway redeem (Ping release claim 2026-11-02, UNVERIFIED on our tenant)

Mock-only playground mode `gateway-redeem`: the gateway exchanges the caller token (leg 1) and redeems it at the target app's own issuer (leg 2, only when `Redeem.TokenURL` is set). Engine `server/src/gatewayRedeem.js`, mocks `server/src/mock/gatewayWorld.js`, routes `server/src/gatewayRedeemRoutes.js`, panel `web/src/pages/GatewayRedeemPanel.jsx`. Live answers 409. `ClientSecret` and `PrivateKeyPEM` are write-only: never in a response, trace or error (routes scrub every answer); a test posts recognisable values and greps every answer. Every editable spec field has one mutation test (a coverage test fails when a field has none). The gateway calls only allow-listed https hosts and sends `redirect: 'error'`. Tag every claim as console swagger name (2026-10-31, schema only), lab reading or lab-invented (`CLAIMS`). Say "P1 Privilege Agent App" for the app an agent calls.

## Rules that bite

- Mock mode works with no configuration. Live PingFederate use is owner-run.
- No real tenant IDs, internal hostnames, personal names or customer names. Use `.invalid` or `.example` hosts. `npm run check:forbidden` must pass.
- Never commit `.env` files or keys. The one settings file is `~/Development/.env` (mode 600).
- CSS follows `STANDALONE-CSS-STANDARD.md`: tokens only, no colour literals, no `!important`.
- Diagram labels (web/src/utils/idJagLabelPlacement.js) are placed in screen pixels and drawn counter-scaled, so they keep one size at any zoom. Change a diagram or its zoom limit and run the placement tests; no label may cover a box or another label. No diagram zooms out below `READABLE_MIN_ZOOM` (0.9, so card text is 10px or more on screen), boxes sit 120-200px apart, and a box dropped never refits the view; tests in `diagrams.test.js` and `IdJagDiagramLegibility.test.jsx` pin all three, so a map wider than the canvas pans instead of shrinking. An arrow the router cannot route (a box dragged hard against another) gets a plain orthogonal line from `plainRoute` and a badge placed on it, so its badge never lands on a box when any clear spot exists on that line; a test drags every box of the four older diagrams and pins this. The card text test reads every font-size rule that styles text inside a card, so a smaller rule anywhere in a card fails it.
- Node 26 only (engines, Dockerfile and CI).
