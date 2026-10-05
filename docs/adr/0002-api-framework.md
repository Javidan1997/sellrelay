# ADR 0002 — Typed API framework: Fastify 5 + Zod

- Status: accepted (2026-10-05)

**Options considered.** Fastify 5 + Zod type provider; Hono; NestJS; tRPC.

**Decision.** Fastify 5 with `fastify-type-provider-zod` and Zod 4.

- Mature raw-body access per route, which webhook HMAC verification needs.
- Schema-validated, typed request/response with low overhead.
- First-class hooks for request IDs, auth, error sanitizing and body limits.
- OpenTelemetry instrumentation is available.
- NestJS adds DI weight we don't need. tRPC couples the UI to TypeScript clients, while the API
  must serve several hosts (Shopify shell, standalone web, WordPress plugin).
