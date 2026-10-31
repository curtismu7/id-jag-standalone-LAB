# Content pack

`content-pack.json` (repo root) is this demo's learning content in the shared "demo content pack" format, so a
Learning Hub can list it next to other demos. The format is `docs/content-pack.schema.json` (copied from the
Learning Hub research; see the `$comment` in that file).

The pack is **additive**. The Learn page still reads `web/src/data/terms.json` and `sources.json` directly, and the
vendored-file contract with the AI-DEMO2 app (`docs/sync-with-app.md`) is unchanged.

## How a demo ships one

Keep the pack at the repo root as `content-pack.json`, generated (not hand-edited) from the demo's own data files, with a
test that fails when the committed file differs from the generator output. This repo does that with
`scripts/build-content-pack.mjs` and `scripts/content-pack.test.mjs` (part of `npm test`).

## Regenerate

```
node scripts/build-content-pack.mjs
```

Run it after changing `terms.json`, `sources.json`, the `GUIDES` list in `GuidesPage.jsx` or the diagram files in
`diagrams/`, then commit the result. Output is deterministic (lists sorted by id, no timestamps).
The pack records a git commit only when asked: `node scripts/build-content-pack.mjs --commit=<sha>`. Do not commit that
variant, because the commit would make the drift test fail.

## What is populated

| Field | Source |
|---|---|
| `glossary` | `terms.json`, sorted by id |
| `sources` | `sources.json`, sorted by id |
| `cards` | the `GUIDES` list, plus the playground, Trusted IdPs and Inspector pages (their routes and descriptions are written in the generator, taken from `LearnPage.jsx`) |
| `diagrams` | one per file in `diagrams/` (diagram-studio/1 data), labelled by its title |
| `demo` | constants in the generator; `catalog: "C1"` is the family-plan catalog id |

## Not populated yet

- `documents` (the optional RAG corpus): none shipped.
- `stories` and a card's `story` link: the story files do not exist in this repo yet, so no pointers are invented.
- `demo.baseUrl` and `demo.doctor`: there is no doctor endpoint on `main`, and the default local URL has not been confirmed.
- `source` (repo and commit): present only with `--commit`.
- `glossary[].aliases`: not in `terms.json`.
