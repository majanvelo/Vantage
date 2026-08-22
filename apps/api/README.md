# apps/api

The **backend REST API** (see SPEC.md §3 — all endpoints under `/v1`, JSON over
HTTPS, bearer/JWT auth).

What belongs here:
- Auth (§3.1) — magic link + verify, issues JWT.
- Events (§3.2) — create, get, invite, join.
- Clip upload (§3.3) — presign → direct S3 PUT → complete; list; delete.
- Sync trigger + status polling (§3.4) — Phase 1's trigger.
- Later phases add render trigger + status polling and webhooks (§3.5, §3.6).

Stateless REST service; triggers and polls background work but never does heavy
CPU work itself. Phase 1 scope only for the first build.
