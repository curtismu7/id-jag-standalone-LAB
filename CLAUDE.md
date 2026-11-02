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
- Diagram labels (web/src/utils/idJagLabelPlacement.js) are placed in screen pixels and drawn counter-scaled, so they keep one size at any zoom. Change a diagram or its zoom limit and run the placement tests; no label may cover a box or another label.
- Zoom floor: no diagram zooms out below `READABLE_MIN_ZOOM` (0.9, so card text is 10px or more on screen). Because of it NO diagram's whole map fits its canvas at the overview on a 1440x900 window or a phone (four older maps 1740px wide in the diagram, 1566px on screen at 0.9; gateway-redeem 1140px, 1026px on screen, against a 1022px canvas; a phone canvas is 343x486 at 375x812, 343x399 at 375x667, 358x505 at 390x844; on 1920x1080 only gateway-redeem fits, at zoom 1). Fit and Reset therefore show the floor zoom, not the whole map; the user pans or zooms in. Do not claim an overview that fits. Step views (`?step=N`) and Simulate are cut by the same floor: measured, at 1440x900 20 of the 25 step views leave a lit box not fully in view (23 of 25 at 375x812). README, "Known cost", says so.
- Spacing: the test bound is 120 to 200px between a box and its nearest neighbour (`diagrams.test.js`, tallest card counted as 190px high, a stand-in: real cards are 115 to 185px); the gaps computed that way are 130 to 190px in the four older diagrams and 120 to 150px in gateway-redeem (README says the same). Every box's position is pinned too (`LAYOUT` in `diagrams.test.js`). Boxes sit close so a 100px by 60px drag on screen leaves every arrow a route.
- Dragging: `autoPanOnNodeDrag={false}` on the diagram's ReactFlow. With it on, React Flow pans the view while a box is held near the canvas edge (a 343px phone canvas is nearly all edge), so the box lands further than the pointer moved, often on another box. A test pins the prop for every mode; the browser check is to drag every box by (100,60) and (-100,60) at 375px and 1440px and run the overlap check. A dropped box never refits the view.
- An arrow the router cannot route (a box dragged hard against another) is drawn as a plain orthogonal line from `plainRoute` with a badge only (no words). The badge sits clear of every box when the gap is 24px or more; below that (22 to 24px) it sits in the middle of the gap, dipping at most 1.5px into a box. This is a SEPARATE finer pass in `placeLabels` (`choose`): it runs only for a badge alone (no words showing) whose coarse spot touches the air kept around a box, and offers the middle of every run and a cost that follows how far the circle reaches into the real box. Everywhere else the placement is exactly origin/main's (measured: 0 of 3,240 shipped-diagram scenes differ; a test pins a digest of 1,272 placements). Before it, origin/main put a badge up to 7 to 8px into a box in screen gaps of 21 to 29px. Tests: `FlowEdge.test.jsx` (the draw path), `idJagPlaygroundRouting.test.js` (the line), `idJagLabelPlacement.test.js` (placement, narrow gaps).
- Card text size is pinned by `web/src/pages/__tests__/cardCssScan.js`, used in `IdJagDiagramLegibility.test.jsx`. What it does: it reads every `.css` file under `web/src` (rules in `@media`/`@supports`/`@layer`/`@container`/`@scope`, native nesting with `&`, bare nested selectors and nested `@media`; at-rule statements such as `@layer a, b;` are skipped). For each selector it asks the DOM (`element.matches`) whether it can match the first card of the mock diagram, anything inside it, or any element above it up to `html`, in every card state (each kind in the five diagrams, dim, on, sel; node selected or dragged). `:hover`, `:focus`, pseudo-elements and structural pseudo-classes (`:nth-child`, `:last-child`) count as always on, and an unknown pseudo-class (`:lang()`) is dropped. Page state is assumed possible on the ancestors: attributes in a selector's earlier compounds (`:root[data-theme="dark"]`, `[data-id="pf"]`) are set on every ancestor, and so are classes and ids no element carries (`html.dark`, `body.presenter`), and a `:root[...]`/`html.x`/`body.x` last compound. A matching `font-size` (or the size in `font`) must be at least 10px on screen at the floor zoom: px and rem (rem from the smallest root size any state sets, e.g. the presenter scale), em and % only on `html`/`body`, `calc()`/`min()`/`max()`/`clamp()` and `var()` of custom properties declared in the CSS are evaluated; anything else fails as unreadable. Any `zoom`, `scale`/`matrix` transform, `scale` property, `text-size-adjust` (other than none/auto/100%) or `font-size-adjust` on a matching rule fails, also inside an `@keyframes` the rule names in `animation`. Tests: `cardCssVariants.js` holds 100 CSS snippets that must fail it and 28 that must not.
- Card text scan, NOT covered: inline styles and styles set from JS (customer config sets CSS variables with `setProperty`; `--present-scale` set at runtime); React Flow's own stylesheet (in `node_modules`); the cascade and specificity (every matching rule counts, `!important` and `@layer` order are ignored, a media or container condition is never evaluated: conservative on purpose); only the first card of the mock diagram is rendered, so another card's own content or attributes are reached only through the ancestor and structural relaxations above (`:has()` and attribute rules on the card itself are checked against that one card); a card kind or class no diagram uses (a `k-new` rule) and a card state beyond kind, dim, on, sel, selected, dragging; page state needing a mix of tokens (`.a:not(.b) .cs` is tried with none and with all of its ancestor tokens set, not each combination); any selector jsdom's engine silently reads as no match beyond the ones normalised (escapes, upper-case tags, legacy `:before`, unknown pseudo-classes); an `em`/`%` size on anything but `html`/`body` (fails as unreadable, so over-reported, not missed); a keyframes name supplied through `var()`; things that shrink text without `font-size`, `zoom`, `scale`, `transform: scale`/`matrix` or `text-size-adjust` (a `perspective()` or `translateZ` transform, `filter`, `contain`).
- Node 26 only (engines, Dockerfile and CI).
