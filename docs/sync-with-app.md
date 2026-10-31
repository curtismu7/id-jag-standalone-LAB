# Keeping the kit and the AI-DEMO2 app in sync

Two products, one subject. The kit (`id-jag-standalone`) is the reference ID-JAG implementation that runs on its own;
the AI-DEMO2 app is the demo built into a larger product. They should show the same ID-JAG story, so a change to a
shared idea lands in both. Two mechanisms keep that honest:

1. **Vendored files** (identical copies, enforced by CI) for the pieces that are plain functions and data.
2. **A feature matrix and a PR checklist** for everything else (flow code differs by design).

## 1. Vendored files: the kit is the source

These are copied into the app by a script, and the app's CI fails if a copy is edited by hand or falls out of sync:

| Kit file | App file |
|---|---|
| `web/src/utils/codeSnippet.js` (+ its test) | `demo_api_ui/src/utils/codeSnippet.js` |
| `web/src/utils/realClients.js` | `demo_api_ui/src/utils/realClients.js` |
| `web/src/utils/runReport.js` | `demo_api_ui/src/utils/runReport.js` |
| `web/src/data/terms.json` | `demo_api_ui/src/data/idJagTerms.json` |
| `web/src/data/sources.json` | `demo_api_ui/src/data/idJagSources.json` |

To change one: edit it **here**, commit, then in the kit repo run

```
node scripts/sync-to-app.mjs --app=/path/to/AI-DEMO2     # copies the files and rewrites idJagCore.manifest.json
node scripts/sync-to-app.mjs --app=/path/to/AI-DEMO2 --check   # exit 1 on any difference
```

and commit the result in the app repo (use a worktree there). The manifest names the kit commit and the hash of every
file; the app's `scripts/check-id-jag-core.js` (a Hygiene gate) compares the files to it.

Why copies and not an npm package: a package between two private repos needs a registry or a token in both CI setups.
If that becomes worth it, this table is exactly the package's content.

## 2. Feature matrix (update it in the same PR as the feature)

As of 2026-10-19. "Shared" = vendored above. Anything marked differs is on purpose; anything marked **gap** is a candidate.

| Area | Kit | App | Notes |
|---|---|---|---|
| Sign-in | pi.flow modal; PingFederate signs the kit's own users in | pi.flow modal on PingOne or PingFederate; front door; passkey, OTP, CIBA; AIC popup | The kit has no MFA or AIC; PingFederate cannot run an OIDC IdP hop in pi.flow |
| Playground steps 1-5 (sign in, issue, redeem, call, negative tests) | yes | yes | |
| Step 6: revoke and prove it | yes | yes | PingFederate answers `invalid_request` to a revoked refresh token |
| Interop panel (PingFederate ID-JAG at Authplane, xaa.dev, motd; Run button) | yes | no | **gap**: needs the kit PingFederate's interop SP connections |
| Backends strip | yes (IdP, resource AS, MCP) | yes (IdP, resource AS, MCP gateway) | |
| Code view (redacted `fetch()`) | yes, tabs per step | yes, a Form / JSON / Code view | Snippet builder shared |
| REST \| MCP toggle on the call step | yes | no (MCP in step 4, REST in its own section) | differs |
| OIDC \| SAML | real in `pf-as` (the app signs an assertion, PingFederate trades it; `pingfederate/configure-saml.js`) | no | **gap**: needs the signing key as a secret and the SAML objects on the SE PingFederate (shared; ask first) |
| Resource AS record ("What the resource AS recorded" + link) | yes (`/events`, `/` on the kit's AS) | no | by design: the app's resource AS is oauth-mcp, which has no decision feed |
| Run report download | yes | yes | `runReport.js` is shared |
| Real-client panel (mcpc, VS Code) | yes (setup guides + step 1) | step 1, localhost only, points at the kit | Setup text shared |
| Learn (glossary, sources) | yes | yes | Data shared |
| Per-mode diagrams | yes | yes | Data files are separate and have drifted (**gap**); the app's is the older source |
| Trusted IdPs registry | yes (own page) | yes (panel) | |
| Modes | pf-as, pf-pf (Acme, pi.flow sign-in at Acme), byo, mock | oauth-mcp, pf-pf, byo, mock | different backends |

## 3. PR checklist

Both repos' PR templates ask: *Did this change a shared idea (a playground step, the Code view, Learn, sign-in, a
real-client command)? If so, is the other repo updated or is there an issue for it, and is the matrix above current?*
