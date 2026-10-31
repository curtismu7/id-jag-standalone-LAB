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

## Rules that bite

- Mock mode works with no configuration. Live PingFederate use is owner-run.
- No real tenant IDs, internal hostnames, personal names or customer names. Use `.invalid` or `.example` hosts. `npm run check:forbidden` must pass.
- Never commit `.env` files or keys. The one settings file is `~/Development/.env` (mode 600).
- CSS follows `STANDALONE-CSS-STANDARD.md`: tokens only, no colour literals, no `!important`.
- Node 22 only.
