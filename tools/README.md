# Tools

- `outside-agent.js` plays an outside company's agent end to end: sign in at its IdP, exchange for an ID-JAG
  addressed to our AS, redeem it at our public token endpoint (and, with `--mcp`, call `tools/list`). It prints
  decoded claims and OAuth errors only, never a raw token. Targets: `--target=resource-as` (default:
  `RESOURCE_AS_ISSUER`, client `OUR_AS_CLIENT_ID`, the `idp-<id>` client from My IdPs, resource `ID_JAG_RESOURCE`)
  or `--target=pingfederate` (`PF_URL`, `PF_REDEEMER_CLIENT_ID`, `PF_RESOURCE`). Every address and client comes from
  an option or this repo's settings (env, else the repo-root `.env`); a missing one stops it with the option and
  variable to set. The header comment lists every option.
