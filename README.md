# seo-pipeline — Hybrid SEO internal API + jobs

Internal service for beriklan.co.id / beriklan.my SEO automation (Coolify-deployed).
**No secrets in this repo** — all keys via Coolify env vars.

- `server.js` — Hono API (`/v1/health`, `/v1/publish-ready`, `/v1/publish-ack`,
  `/v1/rank-deltas`, `/v1/jobs/*`, `/v1/freshness/*`, `/v1/earned-media/*`).
  Protected by Cloudflare-IP allowlist + Bearer token + rate limit.
- `jobs/` — news-ping (2h), distribute (6h), geo-monitor (Mon), freshness (daily).
- `db/schema.sql` — Postgres schemas (comy/coid/shared).

Docs: `plan.md` + `SEO-INDEX-LLM-BLUEPRINT.md` in beriklan.co.id repo (private).
