# SellRelay — Research Log

Append-only, dated findings from current sources. Every entry states **where** the fact came from.
Source classes:

- **[official]** — vendor docs or vendor-maintained source code/repositories.
- **[official-snippet]** — the official page exists, but this environment's network policy blocked
  direct fetching, so the fact comes from a search-engine excerpt of that official URL. **Re-verify
  by opening the page before production use.**
- **[secondary]** — third-party article. Used only as a lead; never the sole basis for implementation.

---

## 2026-10-05 — Wave 0 (Foundation + Shopify)

### Environment constraint

`shopify.dev` and `community.shopify.dev` are **blocked by this session's egress proxy** (HTTP 403 /
`EGRESS_BLOCKED`). Shopify facts below therefore come from Shopify's own open-source repositories on
GitHub (`Shopify/shopify-app-js`, `Shopify/shopify-app-template-react-router`) fetched via
`raw.githubusercontent.com` **[official]**, plus search-engine excerpts of shopify.dev pages
**[official-snippet]**. To lift this constraint, add `shopify.dev` to the environment's allowed
domains (Environment settings → Network access).

### Runtime and tooling

| Item                | Finding                                                                                                                                            | Source                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Node.js             | v24 "Krypton" is **Active LTS** (v24.21.0, updated 2026-09-07). v22 is Maintenance LTS. v26 is Current. From v27 the release cycle becomes annual. | [official] https://nodejs.org/en/about/previous-releases |
| Node type stripping | Node 24 runs erasable-syntax TypeScript natively, including through pnpm workspace symlinks (verified locally).                                    | local experiment                                         |
| TypeScript          | npm `latest` = 7.0.2, but `typescript-eslint@8.71.1` peer range is `>=4.8.4 <6.1.0`. **Chosen: 6.0.3.**                                            | npm registry metadata                                    |
| pnpm                | npm `latest` dist-tag = 12.9.1                                                                                                                     | npm registry                                             |
| PostgreSQL          | `postgres:18` official image pulled and used.                                                                                                      | Docker Hub                                               |
| Redis               | `redis:8` official image pulled and used.                                                                                                          | Docker Hub                                               |

### Shopify — API versions

- Official library `@shopify/shopify-api@15.0.0` `ApiVersion` enum, newest stable member:
  `October26 = '2026-10'` (also lists 2024-10 … 2026-07 and `unstable`). **[official]**
  https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/lib/types.ts
- The official React Router template's `shopify.app.toml` sets `[webhooks] api_version = "2026-10"`.
  **[official]** https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml
- The same template's `app/shopify.server.ts` still pins `ApiVersion.October25`. We pin **2026-10**
  everywhere, explicitly, and never use `unstable` or an unversioned endpoint.
- The prompt-preparation assumption "2026-10 is current" holds as of 2026-10-05.

### Shopify — app template and UI

- Official template: `Shopify/shopify-app-template-react-router` (React Router 7.18.2, React 18.3.1,
  `@shopify/shopify-app-react-router` ^3.0.1, `@shopify/app-bridge-react` ^4.2.4,
  `@shopify/polaris-types` 1.0.1, Node `>=22.12`). **[official]**
- `AppProvider` from `@shopify/shopify-app-react-router` renders the App Bridge and Polaris web
  component script tags. **[official-snippet]** https://shopify.dev/docs/api/app-home
- Polaris React is legacy; new apps use Polaris web components. **[official-snippet]**
  https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react
- `@shopify/shopify-app-react-router@3.0.1` peers `react-router ^7.6.2` → React Router 8 is **not**
  compatible yet. We stay on React Router 7.x as the template does.

### Shopify — authentication (managed installation)

Taken from the official library source **[official]**:

- Session tokens: HS256 JWT signed with the app secret. Verify `exp`/`nbf` with 10 s clock
  tolerance, and require `aud === apiKey`. Claims: `iss` (shop admin URL), `dest` (shop URL), `aud`,
  `sub` (user), `exp`, `nbf`, `iat`, `jti`, `sid`.
  (`lib/session/decode-session-token.ts`, `lib/session/types.ts`)
- Token exchange: `POST https://{shop}/admin/oauth/access_token` with JSON body `client_id`,
  `client_secret`, `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
  `subject_token=<session token>`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token`,
  `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`, and
  `expiring='1'|'0'`. (`lib/auth/oauth/token-exchange.ts`)
- Refresh: same endpoint, with `grant_type=refresh_token` and `refresh_token`.
  (`lib/auth/oauth/refresh-token.ts`)
- Offline response fields: `access_token`, `scope`, `expires_in`, `refresh_token`,
  `refresh_token_expires_in`. (`lib/auth/oauth/types.ts`)
- Shop domain validation regex: `^[a-zA-Z0-9][a-zA-Z0-9-_]*\.(myshopify\.com|shopify\.com|myshopify\.io|shop\.dev)[/]*$`,
  plus `admin.shopify.com/store/<handle>` form. (`lib/utils/shop-validator.ts`). SellRelay accepts
  only `*.myshopify.com` for outbound API calls (SSRF hardening). Spin/dev domains are not accepted.
- **Expiring offline tokens are required for new public apps created on or after 2026-04-01**:
  access token lifetime 60 min, refresh token 90 days. Non-expiring offline tokens get auth errors
  for public apps after 2027-01-01. **[official-snippet]**
  https://shopify.dev/changelog/posts/expiring-offline-access-tokens-required-for-public-apps-april-1-2026
  (corroborated by [secondary] sources).

### Shopify — webhooks

- HTTPS webhook headers: `X-Shopify-Hmac-Sha256`, `X-Shopify-Topic`, `X-Shopify-Shop-Domain`,
  `X-Shopify-API-Version`, `X-Shopify-Webhook-Id` (required); `X-Shopify-Event-Id`,
  `X-Shopify-Triggered-At`, `X-Shopify-Name` (optional). Events-style deliveries use lowercase
  `shopify-*` headers. **[official]** `lib/types.ts`, `lib/webhooks/validate.ts`
- HMAC: base64 HMAC-SHA256 of the **raw body** with the app secret. Webhooks triggered manually from
  store notification settings fail validation, so use CLI triggers or real events. **[official]**
- Duplicates: compare `X-Shopify-Event-Id`, which stays the same across retries. **[official-snippet]**
  https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates
- App-specific subscriptions are declared in `shopify.app.toml` (`[[webhooks.subscriptions]]`, with
  `compliance_topics` for the privacy topics). **[official]** template
- Mandatory compliance topics: `customers/data_request`, `customers/redact`, `shop/redact`.
  `shop/redact` is sent 48 h after uninstall. Respond 2xx; complete the action within 30 days.
  **[official-snippet]** https://shopify.dev/docs/apps/build/privacy-law-compliance

### Shopify — Admin GraphQL limits and bulk operations

- Bulk query: `bulkOperationRunQuery` returns JSONL; `url` and `partialDataUrl` stay downloadable
  for 7 days. **Since 2026-01, up to 5 concurrent bulk query operations per shop per app.**
  **[official-snippet]** https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/bulkoperationrunquery
- Calculated query cost and throttle status are returned in `extensions.cost`
  (`requestedQueryCost`, `actualQueryCost`, `throttleStatus{maximumAvailable,currentlyAvailable,restoreRate}`).
  Bucket sizes differ by plan. **We read `throttleStatus` from each response instead of hard-coding
  limits.** The specific numbers (e.g. 2,000 points, 100 points/s restore) come from a [secondary]
  source and are used only as fallback defaults.
- Bulk queries are limited in connection depth (two levels of nested connections). We therefore
  split exports into products→variants and inventoryItems→inventoryLevels. **Re-verify the exact
  bulk-query limits on shopify.dev.** [official-snippet / needs re-verification]

### Shopify — billing (Shopify App Pricing)

- On 2026-05-12 Managed Pricing was rebranded and extended as **Shopify App Pricing**, the default
  for public apps. Plans are configured in the Partner Dashboard and support recurring, usage-based
  (via the **App Events API**) or combined pricing. The Billing API is now **legacy**.
  **[official-snippet]**
  https://shopify.dev/changelog/posts/shopify-app-pricing-charge-for-usage-recurring-subscriptions-or-both,
  https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
- On 2026-07-09 public plans increased from 4 to 8, and every plan became open to $0 testing by
  reviewers and development stores. [secondary — re-verify]
- Entitlement verification: the Partner API root query `activeSubscription(appId:, shopId:)`
  returns the live contract. It requires a Partner API client with the "Manage apps" permission.
  Also query Admin API `currentAppInstallation` for Billing-API subscriptions; do not treat a
  merchant as unpaid until both say so. **[official-snippet]**
  https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/migrating-to-shopify-app-pricing
- `plan_handle` is included in the `app_subscriptions/update` webhook, and `planHandle` is on
  `AppRecurringPricing`. **[official-snippet]** https://shopify.dev/changelog/new-planhandle-field-managed-pricing
- Plan selection page: `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`.
  **[official-snippet]** https://shopify.dev/docs/apps/launch/billing/managed-pricing
- **Blocked:** the exact `ActiveSubscription` Partner API field schema and the App Events API
  endpoint/auth could not be read (shopify.dev blocked). Usage reporting and the Partner API query
  are **not implemented**; they return a typed `blocked` result. See GATE_REPORT.

### Items explicitly not yet researched (later waves)

Amazon SP-API, eBay (including the marketplace account-deletion notification), Walmart, Etsy,
TikTok Shop, OTTO Market partner requirements, Zoho data-centre endpoints, METRO, Kaufland,
Allegro, bol.com, HubSpot, Pipedrive, Odoo and other hosts' packaging/billing. Each is researched at
the start of its wave, and the registry marks them `planned` with approval `pending`.
