# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Shopify embedded app (internally "Fletix" / "Delivery Rules" / "CityRates" — see Variants below) that provides configurable shipping rates per department + city, weight/cart-total tiers, schedules, and product conditions. It plugs into checkout as a **Carrier Service** (real-time rates) plus a **Checkout Validation Function** (blocks undeliverable carts), and publishes rules to a **public shop metafield** so any storefront theme can read them.

Code comments and docs are in Spanish; keep that convention when editing.

## Commands

```bash
npm run dev            # shopify app dev --config=custom (tunnel + embedded preview)
npm run dev:public     # / dev:demo — other deploy configs
npm run build          # prisma generate + react-router build
npm run setup          # prisma generate + prisma migrate deploy
npm run deploy         # deploy app version + extensions (--config=custom; also deploy:public/:demo)
npm run lint           # eslint
npm run typecheck      # react-router typegen + tsc --noEmit
npm run test           # vitest run
npm run test:watch
npx vitest run tests/rate-engine.test.js          # single test file
npx vitest run -t "name of test"                  # single test by name
```

Node `>=20.19 <22 || >=22.12`. Postgres in prod; local dev uses SQLite via empty `DATABASE_URL` (the schema declares `postgresql` — local dev relies on Shopify CLI / env override).

## Stack

React Router v7 (fs-routes, file-based) + Vite · Prisma + Postgres · Polaris + App Bridge React · Shopify Admin API `2026-04` (`ApiVersion.April26`) · Shopify Functions (validation) · Theme App Extension (storefront rate calculator).

## Architecture

**`app/rate-engine.server.js` is the single source of truth** for "given a destination + cart, which rates apply." It is shared by two callers and must stay caller-agnostic:
- `app/routes/api.carrier-service.jsx` — the real Shopify checkout callback (handles HMAC, rate-limit, payload parsing, Shopify response format only).
- `app/routes/app.quotes.jsx` — the admin rate simulator.

**`app/mox-shipping-rules.server.js`** holds the rules domain logic (CRUD helpers, city normalization, schedule evaluation, `getRatesForDestination`) and `syncRulesToMetafield`. Both the admin UI and the engine import from it.

**Carrier service endpoint is public** (no `authenticate.admin`). The shop is identified by `?shop=` appended when the carrier service is registered. It verifies Shopify's HMAC (`app/utils/shopify-hmac.server.js`) and rate-limits by IP.

**Metafield dual-namespace.** Rules are written to the canonical `fletix.shipping_rules` AND legacy `mox_store_promise.shipping_rules` simultaneously, so unmigrated themes keep working. See `TODO-NAMESPACE-MIGRATION.md` before removing the legacy write.

**Quote log.** Every carrier request is persisted fire-and-forget to `RateQuote` (never blocks/delays the checkout response) for merchant diagnostics in `/app/quotes`. Retention is opportunistic — see `QUOTE_RETENTION_DAYS` in `quote-log.server.js`.

**Install bootstrap** runs in `shopify.server.js` `afterAuth`: `ensureShopRecord` → `captureShopMeta` (currency/timezone/country) → `ensureFletixCarrierService` → `syncRulesToMetafield`. Every step is best-effort and must never throw — a thrown error breaks first-install and fails App Review.

### Data model (`prisma/schema.prisma`)

- `AppShop` — one row per install. `sponsoredPro` = Pro without a Shopify subscription. Caches `currency`/`ianaTimezone`/`country` (default COP/America/Bogota/CO) and `cityMatchThreshold` (fuzzy city match %, default 85).
- `ShippingZone` (per shop, `@@unique([shop, slug])`) → has many `ShippingRate`. `country` defaults `"CO"` and is NOT part of the lookup key — slugs stay stable so deployed themes keep reading existing CO slugs.
- `ShippingRate` — `pricingMode` flat/weight_tiers/cart_total, city include/exclude + aliases, schedule (timeFrom/To, daysOfWeek), generalized product conditions (`productField` tags/vendor/product_type/collection/sku). `price` is in MAJOR currency units (Float).
- `Session` — Shopify session storage.
- `RateQuote` — the quote log (see above).

Many fields are JSON-encoded strings (e.g. `cities`, `weightTiers`, `decisions`). Parse/stringify at the boundary.

## Variants & billing (read before touching env or plan logic)

The same repo deploys as multiple branded apps via `shopify.app.{custom,public,demo}.toml`. Brand is selected by `APP_VARIANT` (server, `process.env`) and `VITE_APP_VARIANT` (client, inlined by Vite). **Both must be set to the same value** in every deployment — if they diverge, `planInfo.plan === PLAN_PRO` silently mismatches and the app appears unsubscribed. Canonical variant value is `deliveryrules` (alias `cityrates`); anything else is legacy Fletix. The branch lives in `app/utils/variant.js` (`isDeliveryRules`) and plan names in `app/utils/billing.constants.js`.

`billing.constants.js` is imported by both server and client. In the browser `process` is undefined — accessing `process.env.X` throws and silently disables every button. Use `import.meta.env` for client-safe values, fall back to `process.env` on the server.

`BILLING_MODE`:
- `managed` — Shopify App Pricing; app redirects to the hosted plan page, MUST NOT call `appSubscriptionCreate`. Needs `APP_HANDLE` matching the toml `handle`.
- `api` — legacy Billing API (`appSubscriptionCreate` + confirmationUrl). Default if unset.
- `custom` — TEST/PREVIEW ONLY; flips `AppShop.sponsoredPro` for an instant Free↔Pro flow, no Shopify charge. Never use in production.

## Extensions

- `extensions/fletix-checkout-validation/` — Shopify Function (Cart Validations) that blocks checkout when a cart item isn't deliverable to the final address. Has its own `package.json` / vitest (workspace).
- `extensions/fletix-rate-calculator/` — Theme App Extension; PDP rate calculator (Pro plan), reads the public metafield.
