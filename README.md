# mock-api

Instant mock REST APIs from a JSON Schema. Describe a resource, get a real CRUD endpoint
backed by its own storage — no backend to write, no account required for the free tier.

## What it does

- `POST /api/projects` creates a project: a manage token (owner-only, for defining
  collections) and a consumer API key (used to call the generated endpoints).
- `POST /api/projects/:id/collections` defines a collection from a small JSON Schema subset
  (`type: "object"`, flat `properties`, `required`, enums, formats, numeric/length bounds,
  arrays of scalars). The schema is validated before it is accepted, and an optional `seed`
  count fills it with plausible fake data matching that schema.
- Every collection then has a full mock REST API under `/mock/:projectId/:collection`:
  `GET` (list, with `limit`/`offset` pagination and exact-match query filters on any schema
  field), `GET /:id`, `POST`, `PUT`, `PATCH`, `DELETE` — all validated against the schema on
  write (unknown fields are rejected).
- Plans (free/pro/business, raised by an admin-issued `x-api-key` at project-creation time)
  differ in how many projects/collections/records are allowed, request-body size, and
  requests/minute. Anonymous creation gets the free plan.
- Abuse protection: per-IP and per-project-key rate limits, a global live-project cap,
  per-plan collection/record caps, capped request bodies, and schema `pattern` fields are
  length-capped and screened for the classic catastrophic-backtracking shapes before being
  accepted (`new RegExp()` is still fallible in theory for pathological inputs not caught by
  the heuristic — see Limits below). mock-api makes no outbound network calls of its own, so
  there is no SSRF surface the way a webhook-delivery product would have.
- Projects expire automatically (TTL per plan) and are purged from disk on a timer, same as
  webhook-inbox.

## Run locally

```bash
npm install
cp .env.example .env   # edit ADMIN_TOKEN at minimum
npm run dev             # http://localhost:3610
```

Open `http://localhost:3610` for a small page that creates a project + collection from a
JSON Schema textarea and shows the generated base URL, API key, and a ready-to-run curl
command. Or do it directly:

```bash
curl -X POST http://localhost:3610/api/projects -H 'content-type: application/json' -d '{"name":"demo"}'
# -> { id, manageToken, apiKey, baseUrl, manageUrl, plan, expiresAt, limits }

curl -X POST http://localhost:3610/api/projects/<id>/collections \
  -H 'content-type: application/json' -H 'authorization: Bearer <manageToken>' \
  -d '{"name":"todos","schema":{"type":"object","properties":{"title":{"type":"string"},"done":{"type":"boolean"}},"required":["title"]},"seed":3}'

curl http://localhost:3610/mock/<id>/todos -H 'x-api-key: <apiKey>'
curl -X POST http://localhost:3610/mock/<id>/todos -H 'content-type: application/json' -H 'x-api-key: <apiKey>' -d '{"title":"buy milk"}'
```

## Supported schema subset

Top level must be `{ "type": "object", "properties": {...}, "required": [...] }`. Each field:
`type` is one of `string`/`number`/`integer`/`boolean`/`array` (array items must be one of the
scalar types — no nested arrays/objects). Optional: `enum`, `format`
(`email`/`uuid`/`date`/`date-time`), `minLength`/`maxLength`, `minimum`/`maximum`, and a
length-capped `pattern`. `additionalProperties: true` is rejected — writes always reject
fields that are not in the schema.

## Tests

```bash
npm run typecheck
npm run lint
npm test     # vitest: schema validator (41 unit cases) + full app integration tests
```

`tests/schema.test.ts` covers the JSON Schema validator and fake-data generator directly.
`tests/app.test.ts` drives the real Hono app (in-memory SQLite) through project/collection
creation, full CRUD, pagination/filtering, tenant isolation (one project cannot see another's
data even by guessing collection names), plan limits, rate limiting, and the admin key API —
plus a check that error responses never leak internals (stack traces, file paths).

A live smoke run against a real `node --import tsx src/server.ts` server on `:3610` was done
by hand with curl: health check, create project, create collection with seed data, list
(seeded rows present), create, patch, reject-on-missing-required-field (400), reject-on-wrong
api-key (404, same as unknown project — no existence oracle), delete, and the landing page
(200).

## Deploy

Needs a host with a **persistent disk** (SQLite file) — not a serverless/edge platform like
Vercel. A small VPS, Fly.io, or Railway works. Put a domain + TLS in front of it and set
`PUBLIC_URL` so generated base/manage URLs are correct.

## Known limits / not verified

- Rate limiters are in-memory (per-process) — fine for a single instance, not for a
  multi-process deployment behind a load balancer.
- No signup/billing UI; upgraded API keys are minted manually via `/admin/keys`.
- The `pattern` ReDoS guard is a heuristic (length cap + rejecting the common nested-quantifier
  shapes), not a formal proof; treat user-supplied patterns as semi-trusted even so.
- No nested objects/arrays-of-objects in schemas (flat resources only) — a deliberate scope cut,
  not a bug.
- Visual/accessibility review of the landing page was done by eye only (no real-browser
  automated check, unlike webhook-inbox); not checked on Safari/iOS.

## Accounts needed to go live

None for the code itself. To actually sell/host it: a VPS/PaaS with persistent disk, a domain,
and (optionally) a payment provider if you charge for pro/business plans.
