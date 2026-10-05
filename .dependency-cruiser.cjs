/**
 * Dependency boundaries for SellRelay. Enforced in CI (`pnpm deps:check`).
 * A test (tests/unit/dependency-boundaries.test.ts) proves forbidden imports fail.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      severity: 'error',
      comment:
        'packages/core must not import SDKs, UI libraries, HTTP frameworks, DB/Redis clients, node builtins or other workspace packages.',
      from: { path: '^packages/core/src' },
      to: { pathNot: '^packages/core/src' },
    },
    {
      name: 'no-infra-in-integrations',
      severity: 'error',
      comment:
        'Platforms, connectors and billing implement core ports; they must not reach into persistence, services or apps.',
      from: { path: '^packages/(platforms|connectors|billing)/' },
      to: { path: '^(packages/persistence|services|apps)/' },
    },
    {
      name: 'no-cross-integration-imports',
      severity: 'error',
      comment: 'One platform/connector must not import another; share code through core.',
      from: { path: '^packages/(platforms|connectors/[^/]+)/([^/]+)/' },
      to: { path: '^packages/(platforms|connectors/[^/]+)/', pathNot: '^packages/$1/$2/' },
    },
    {
      name: 'persistence-no-integrations',
      severity: 'error',
      from: { path: '^packages/persistence/' },
      to: { path: '^(packages/(platforms|connectors|billing)|services|apps)/' },
    },
    {
      name: 'application-layer-on-top',
      severity: 'error',
      comment: 'Only services may use the application orchestration layer.',
      from: {
        path: '^packages/(core|persistence|platforms|connectors|billing|security|ratelimit|observability)/',
      },
      to: { path: '^packages/application/' },
    },
    {
      name: 'packages-not-depend-on-services-or-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^(services|apps)/' },
    },
    {
      name: 'shopify-shell-is-thin',
      severity: 'error',
      comment:
        'apps/shopify is a thin embedded shell. It talks to services/api over HTTP and must not embed persistence, adapters or business engines.',
      from: { path: '^apps/shopify/' },
      to: {
        path: '^(packages/(persistence|platforms|connectors|billing)|services)/|node_modules/.*/(pg|ioredis)/',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(/build/|/dist/|\\.react-router)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    preserveSymlinks: false,
  },
};
