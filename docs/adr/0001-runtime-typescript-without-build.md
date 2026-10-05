# ADR 0001 — Run TypeScript natively on Node 24 LTS

- Status: accepted (2026-10-05)

**Context.** We need strict TypeScript across a pnpm monorepo with minimal build complexity.
Node 24 (Active LTS) strips erasable TypeScript syntax natively.

**Decision.** Services and packages are authored as erasable-syntax TypeScript
(`erasableSyntaxOnly`, `verbatimModuleSyntax`, explicit `.ts` import extensions) and executed
directly by Node 24. `tsc --noEmit` provides strict type checking in CI. The Shopify shell is the
exception: it is built with Vite / React Router as the official template does.

**Consequences.** No enums, namespaces or parameter properties. Type-only imports must use
`import type`. Workspace packages export `./src/index.ts`. Container images run `node file.ts`.
