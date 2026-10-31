# Health contract: demo-health/1

Every demo that wants a light on the SE demo shelf answers one public request. (This file is the demo side of the
contract; the shelf's own `docs/health-contract.md` carries the full version and must stay consistent with it.)

```
GET /api/health        200, Content-Type: application/json, Cache-Control: no-store
{
  "schema": "demo-health/1",
  "at": "2026-10-21T12:00:00.000Z",     // ISO time of the last check (cold start: now)
  "state": "ready",                     // ready | needs-setup | broken | unknown
  "runtime": "offline",                 // offline | live
  "demo": { "id": "id-jag", "name": "ID-JAG Standalone", "version": "0.1.0" }
}
```

Rules: public (no sign-in), GET only (every other method, HEAD included, answers 405 with `Allow: GET`, so the shelf must poll with GET, not HEAD), query parameters ignored, no
counts, no message text, no secrets, no per-check detail. Detail stays on the admin-only `/api/doctor`.

| state | meaning |
| --- | --- |
| `ready` | the doctor ran and nothing failed (warnings do not count) |
| `needs-setup` | the doctor reported at least one failure |
| `unknown` | the doctor has not finished its first run yet, threw, or timed out |
| `broken` | reserved: the process itself cannot serve. Not produced today (a process that answers is not broken) |

`runtime` is `offline` when the kit runs in mock mode with no PingFederate admin settings, else `live`.

## How this kit computes it

`server/src/health.js` runs the doctor once at boot and refreshes it in the background every 60 s with a 15 s hard
timeout (one run at a time). A request only reads the cached result, so a stuck poller cannot cause doctor runs;
it is also limited to 60 requests a minute per address. The doctor mode is `HEALTH_MODE` (`mock|pf-as|pf-pf|byo`),
else `pf-as` when `PF_EXCHANGE_CLIENT_ID` or `PF_ADMIN_URL` is set, else `mock`.

PingFederate admin: health never calls the admin API itself. Its only path is `runDoctor`, whose PF slice lives in
the IdP adapter (`server/src/idp/pf-local.js`) and goes through the guarded client (`server/src/idp/pfAdmin.js`).
When that client's failure latch is closed (two 401/403 answers pause it for 15 minutes) the doctor makes no call and
reports a failure, so health answers `needs-setup` with no new admin attempt. Unlatched, the load is the doctor's
single attempt per run.

Workspace seam: health describes the process, not a tenant. The refresh always runs in the `default` workspace
(`server/src/workspace.js`), and `/api/health` answers from that one cached result in every workspace; it is not
behind `requireDefaultWorkspace` and takes no workspace-specific input.
