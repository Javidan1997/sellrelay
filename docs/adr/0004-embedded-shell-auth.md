# ADR 0004 — Thin Shopify shell; authentication owned by services/api

- Status: accepted (2026-10-05)

**Decision.** `apps/shopify` (React Router 7, official template structure) renders the Polaris web
components UI and uses `AppProvider` for App Bridge. It does **not** use the template's
Prisma session storage or `authenticate.admin`. Browser requests go to the shell's same-origin
`/api/*` route, where App Bridge attaches the session token as `Authorization: Bearer`. The shell
forwards them to `services/api` without inspecting them.

`services/api` verifies the session token using `@sellrelay/platform-shopify`, resolves the tenant
from the verified shop plus membership, and performs the managed-install token exchange (expiring
offline token). It stores credentials encrypted. Webhooks are received by `services/api`, verified
against the raw body by the same package, and persisted to the inbox.

**Consequences.** One token store and one webhook pipeline serve every host UI. A standalone
dashboard (Wave P1) uses a different identity verifier and reuses the same API.
