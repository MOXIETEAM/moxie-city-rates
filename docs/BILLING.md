# Billing flow — implementation guide

End-to-end billing reference for Shopify embedded apps built with
`@shopify/shopify-app-react-router`. Two billing modes are supported in the
same codebase:

- **Managed Pricing** (Shopify App Pricing) — required for new public apps
  on the Shopify App Store. Plans live in Partner Dashboard, merchants
  subscribe on Shopify-hosted pages. The Billing API is forbidden.
- **API** (legacy Billing API) — `appSubscriptionCreate` mutation. Used for
  custom or legacy deployments that pre-date Shopify App Pricing.

Mode is selected per deployment via `BILLING_MODE` env var.

---

## 1. Why this guide exists

We hit every single failure mode the docs warn about, so the patterns here
are battle-tested:

| Failure observed                                | Root cause                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Buttons did nothing on click                    | `process.env.X` in a client-imported module crashed Vite hydration               |
| "Unexpected token '<'... is not valid JSON"     | `fetch()` POST to a route action without `_data=…` returns the rendered HTML    |
| 401 redirect loop ending at `/auth/login`       | `target="_top"` on an anchor pointed at the app's own URL (lost embedded ctx)    |
| `Managed Pricing Apps cannot use Billing API`   | `appSubscriptionCreate` is forbidden once you opt into Shopify App Pricing       |
| `currentAppInstallation.app.handle` was `null`  | The TOML had no `handle = "..."` registered, or `shopify app deploy` hadn't run  |
| `top.location.href` silently blocked            | Iframe sandbox `allow-top-navigation-by-user-activation` lost activation         |
| Loader 500 = ErrorBoundary "Unexpected Server"  | A single thrown error from `getShopPlan` or Prisma propagated out of the loader  |

The patterns below avoid all of them.

---

## 2. Architecture

```
shopify.app.<config>.toml                  ← handle, scopes, webhooks
app/
  shopify.server.js                        ← shopifyApp() init + billing config
  utils/
    billing.constants.js                   ← PLAN_FREE / PLAN_PRO (browser-safe!)
    billing.server.js                      ← getShopPlan, PLAN_LIMITS, checkLimit
  routes/
    app.billing.jsx                        ← plans UI + cancel action
    app.billing.subscribe.jsx              ← subscribe action (api mode)
    app._index.jsx                         ← home with paywall banner
    app.shipping-rules.jsx                 ← gated feature with paywall banner
```

The flow:

1. Every loader that needs to know the plan calls `getShopPlan(billing, shop, admin)`.
2. UI gates features via `checkLimit(planInfo, "...", currentCount)`.
3. When the merchant is not Pro, a paywall banner shows a **native
   `<a target="_top" href={planSelectionUrl}>`** anchor pointing at
   `admin.shopify.com/.../pricing_plans` (Managed) or `/app/billing` (API).
4. The subscribe action only runs in `BILLING_MODE=api` mode. In `managed`
   mode the banner is the entire subscribe flow — no fetch, no JSON, no
   App Bridge interception needed.

---

## 3. Environment variables

Set these per deploy. **Both `APP_VARIANT` and `VITE_APP_VARIANT` must match**
or server and client will disagree on plan names.

| Var                  | Required               | Example                | Notes                                                    |
| -------------------- | ---------------------- | ---------------------- | -------------------------------------------------------- |
| `SHOPIFY_API_KEY`    | always                 | `7d47f8bd…`            | Client ID from Partner Dashboard                         |
| `SHOPIFY_API_SECRET` | always                 | `shpss_…`              | Client secret from Partner Dashboard                     |
| `SHOPIFY_APP_URL`    | always                 | `https://app.example`  | No trailing slash                                        |
| `SCOPES`             | always                 | `read_shipping,…`      | Must match `[access_scopes]` in TOML                     |
| `DATABASE_URL`       | production             | Postgres URL           | Used by Prisma                                           |
| `NODE_ENV`           | production             | `production`           | Drives `resolveBillingTestMode`                          |
| `APP_VARIANT`        | always                 | `cityrates` / `fletix` | Server-side plan name selector                           |
| `VITE_APP_VARIANT`   | **always (must match)**| same as APP_VARIANT    | Client-side, Vite inlines at build                       |
| `BILLING_MODE`       | always                 | `managed` or `api`     | Default `api`                                            |
| `APP_HANDLE`         | when `managed`         | `city-rates`           | Must match `handle = "..."` in TOML                      |

### Why both `APP_VARIANT` and `VITE_APP_VARIANT`?

`process.env.X` (other than `NODE_ENV`) does **not** exist in the browser
bundle. `app/utils/billing.constants.js` is imported by client code, so it
reads `import.meta.env.VITE_APP_VARIANT` for the client and falls back to
`process.env.APP_VARIANT` for SSR. If they diverge, `planInfo.plan === PLAN_PRO`
on the client compares against a different string than what the server stored.

---

## 4. Code — `app/utils/billing.constants.js`

The browser-safe constants. **Never reference `process.env` directly in a
module imported by client code** without the `typeof` guard.

```js
const APP_VARIANT =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_APP_VARIANT) ||
  (typeof process !== "undefined" && process.env?.APP_VARIANT) ||
  "";

const isCityRates = APP_VARIANT === "cityrates";

export const PLAN_FREE = isCityRates ? "Free" : "Fletix Free";
export const PLAN_PRO = isCityRates ? "Pro" : "Fletix Pro";
```

Plan names are passed verbatim to Shopify. Once a subscription exists, the
name is locked in for that subscription's lifetime — changing the constant
detaches existing subscribers.

---

## 5. Code — `app/utils/billing.server.js`

```js
export const PLAN_LIMITS = {
  [PLAN_FREE]: { maxZones: 0, maxRatesPerZone: 0, /* every feature: false */ },
  [PLAN_PRO]:  { maxZones: Infinity, maxRatesPerZone: Infinity, /* features: true */ },
};

// Resolves isTest defensively. Fails open (returns true) on any GraphQL
// error so a transient network blip during App Review never produces a
// real charge on a dev store.
export async function resolveBillingTestMode(admin) {
  if (process.env.NODE_ENV !== "production") return true;
  if (!admin) return true;
  try {
    const res = await admin.graphql(
      `query { shop { plan { partnerDevelopment } } }`,
    );
    const json = await res.json();
    return json?.data?.shop?.plan?.partnerDevelopment === true;
  } catch {
    return true;
  }
}

export async function getShopPlan(billing, shop, admin) {
  const isTest = await resolveBillingTestMode(admin);
  try {
    const { hasActivePayment, appSubscriptions } = await billing.check({
      plans: [PLAN_PRO],
      isTest,
    });
    if (hasActivePayment && appSubscriptions.length > 0) {
      return { plan: PLAN_PRO, limits: PLAN_LIMITS[PLAN_PRO], /* … */ };
    }
  } catch (e) {
    // log + fall through to PLAN_FREE
  }
  // Optional: check a sponsoredPro flag in DB for free overrides.
  return { plan: PLAN_FREE, limits: PLAN_LIMITS[PLAN_FREE], /* … */ };
}

export function checkLimit(planInfo, type, currentCount) {
  // Boolean limits (`weightTiers`, `csv`, etc.) return `limits.X`.
  // Counted limits (`zones`, `ratesPerZone`) return `currentCount < limits.maxX`.
}
```

---

## 6. Code — `app/routes/app.billing.jsx`

The plans page. Two responsibilities:

1. Show the merchant their current plan + features
2. Render the subscribe CTA correctly per `BILLING_MODE`

The loader pre-computes `planSelectionUrl` server-side so the UI can be a
plain anchor — no client logic needed.

```js
export const loader = async ({ request }) => {
  const { billing, session, admin } = await authenticate.admin(request);

  let planInfo;
  try {
    planInfo = await getShopPlan(billing, session.shop, admin);
  } catch (e) {
    logError("[billing loader] getShopPlan failed", e);
    planInfo = { plan: PLAN_FREE, limits: PLAN_LIMITS[PLAN_FREE], /* … */ };
  }

  // Managed Pricing plan-selection URL — purely server-side string build.
  // Same origin as the parent Shopify Admin frame, so `target="_top"` on the
  // UI anchor escapes the iframe without any sandbox issues.
  let planSelectionUrl = null;
  if (process.env.BILLING_MODE === "managed") {
    const appHandle = (process.env.APP_HANDLE || "").trim();
    const storeHandle = (session.shop || "").replace(/\.myshopify\.com$/, "");
    if (appHandle && storeHandle) {
      planSelectionUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
    }
  }

  return {
    planInfo,
    planSelectionUrl,
    billingMode: process.env.BILLING_MODE === "managed" ? "managed" : "api",
  };
};
```

Action handles `cancel_subscription` only — every branch wrapped in
`try/catch` returning a plain `{ success, error }` envelope. Returning a
Response with status 500 triggers React Router's ErrorBoundary, which Shopify
App Review treats as a hard rejection signal. Return status 200 with the
error in the payload instead.

### UI — render rule

```jsx
<PlanCard
  isCurrent={isPro}
  actionLabel={isPro ? t("billing.downgrade") : t("billing.start_trial")}
  onAction={isPro ? handleDowngrade : billingMode === "managed" ? undefined : handleStartTrial}
  actionHref={!isPro && billingMode === "managed" ? planSelectionUrl : undefined}
/>
```

`PlanCard` renders a `<button>` when `onAction` is set and an `<a target="_top">`
when `actionHref` is set. Managed Pricing always uses the anchor.

---

## 7. Code — `app/routes/app.billing.subscribe.jsx`

Only used in `BILLING_MODE=api`. In `managed` mode the file still exists for
backward compatibility but the UI never hits it.

Two non-negotiables:

1. **Every return uses `new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })`.**
   Returning a plain object from an action only serializes to JSON when the
   request URL has `?_data=...` or ends in `.data`. A bare `fetch("/app/billing/subscribe", { method: "POST" })`
   renders the route component as HTML and the client gets "Unexpected token '<'".

2. **Top-level `try/catch` always returns 200.** Any throw → React Router
   renders the global ErrorBoundary → App Review rejection.

```js
function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const action = async ({ request }) => {
  try {
    const { billing, session, admin } = await authenticate.admin(request);
    // … call appSubscriptionCreate via admin.graphql, never billing.request …
    return json({ success: true, confirmationUrl });
  } catch (e) {
    logError("[billing.subscribe] unhandled", e);
    return json({ success: false, error: e?.message || "Subscription failed" });
  }
};
```

Client handler (only used in `api` mode):

```js
const res = await fetch("/app/billing/subscribe", {
  method: "POST",
  headers: { Accept: "application/json" },
});
const text = await res.text();
let data;
try { data = JSON.parse(text); }
catch { /* show "Server returned HTML…" error inline */ }
if (data.confirmationUrl) {
  // Top-frame navigation MUST happen inside this handler so transient
  // activation from the click is still alive.
  const top = window.top || window.parent || window;
  top.location.href = data.confirmationUrl;
}
```

---

## 8. Paywall banners — every gated route

Any route that hides features behind Pro **must** show an explanation
banner when the merchant is on Free. App Review rejects pages where buttons
are disabled without an inline message telling the merchant why.

Pattern (used in `app._index.jsx`, `app.shipping-rules.jsx`):

```jsx
{!isPro && (
  <div role="alert" /* paywall styling */>
    <h2>{t("billing.needs_subscription_title")}</h2>
    <p>{t("billing.needs_subscription_desc")}</p>
    {billingMode === "managed" && planSelectionUrl ? (
      <a href={planSelectionUrl} target="_top" rel="noopener noreferrer">
        {t("billing.needs_subscription_cta")}
      </a>
    ) : (
      <a href="/app/billing">{t("billing.needs_subscription_cta")}</a>
    )}
  </div>
)}
```

The loader exposes `planSelectionUrl` + `billingMode` (same pre-compute
snippet as `app.billing.jsx`).

---

## 9. Defensive loaders — never 500

Every loader that calls Shopify or Prisma wraps each external dependency
individually so one transient failure doesn't take out the page.

```js
export const loader = async ({ request }) => {
  const { billing, session, admin } = await authenticate.admin(request);

  let planInfo;
  try { planInfo = await getShopPlan(billing, session.shop, admin); }
  catch (e) {
    logError("[loader] getShopPlan failed", e);
    planInfo = { plan: PLAN_FREE, limits: PLAN_LIMITS[PLAN_FREE], /* … */ };
  }

  let zoneCount = 0;
  try { zoneCount = await prisma.shippingZone.count({ where: { shop: session.shop } }); }
  catch (e) { logError("[loader] zone count failed", e); }

  return { planInfo, zoneCount };
};
```

Same pattern for actions — wrap the entire body in `try/catch` and return a
JSON envelope with `success: false, error: …` instead of throwing.

---

## 10. App Bridge — must be in `<head>`

Since 2024-03-13 Shopify requires the App Bridge script tag in the document
head, not loaded via React after hydration. The root route handles this:

```jsx
// app/root.jsx
export const loader = async () => ({
  apiKey: process.env.SHOPIFY_API_KEY || "",
});

export default function App() {
  const { apiKey } = useLoaderData();
  return (
    <html>
      <head>
        {apiKey && <meta name="shopify-api-key" content={apiKey} />}
        {apiKey && (
          <script
            src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
            data-api-key={apiKey}
          />
        )}
      </head>
      <body><Outlet /></body>
    </html>
  );
}
```

Without this, fetch is not patched in time for the first request, session
tokens are missing, and every billing action 401s.

---

## 11. `afterAuth` must never throw

`shopify.server.js` wraps every helper in `afterAuth` because a thrown
error aborts the install flow and Shopify App Review rejects "broken
install".

```js
hooks: {
  afterAuth: async ({ session, admin }) => {
    try { await ensureShopRecord(session.shop); } catch (e) { warn(e); }
    await ensureFletixCarrierService(admin, session.shop); // helper never throws
    try { await syncRulesToMetafield(admin, session.shop); } catch (e) { warn(e); }
  },
},
```

---

## 12. TOML — required fields for Managed Pricing

```toml
client_id = "..."
name = "..."
handle = "city-rates"                    # ← REQUIRED for Managed Pricing
application_url = "https://..."
embedded = true

[webhooks]
api_version = "2026-04"

  [[webhooks.subscriptions]]
  uri = "/webhooks/compliance"
  compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]
```

The `handle` value populates the URL
`admin.shopify.com/store/<store>/charges/<HANDLE>/pricing_plans`.
**Run `shopify app deploy --config=<name>` after adding it** — Shopify only
registers the handle on deploy. Until then `currentAppInstallation.app.handle`
returns `null`.

---

## 13. Partner Dashboard — Managed Pricing setup

For the public app submission:

1. **Distribution** → "Public app — Shopify App Pricing"
2. **App setup → Pricing** → Opt in "Shopify App Pricing"
3. Create public plan:
   - Name **must match** the `PLAN_PRO` constant (e.g. `"Pro"`)
   - Price, currency, billing interval, trial days
4. Create **private** `$0` plan named `"Test"` — visible only to the
   reviewer account so they can subscribe during App Review without
   incurring a charge
5. Save

---

## 14. App Review reviewer notes (paste into submission form)

```
This app uses Shopify App Pricing (Managed Pricing).

To test the billing flow:
1. Open the app from Apps
2. Click "Plans & Pricing" in the top nav (or the "Iniciar prueba"
   button on the home page)
3. You will be redirected to the Shopify-hosted plan selection page
4. Select the "Test" plan ($0, private) to subscribe without charge
5. Verify the app unlocks Pro features (Shipping rules become editable,
   carrier service activates, CSV import/export becomes available)
6. Cancel from the same Shopify pricing page if needed

Test credentials and dev store are included in the submission.
```

---

## 15. Pre-submission checklist

- [ ] `handle = "..."` set in `shopify.app.<config>.toml`
- [ ] `shopify app deploy --config=<name>` run after adding handle
- [ ] Partner Dashboard pricing plans created (public + private $0 test plan)
- [ ] Render env vars: `APP_VARIANT`, `VITE_APP_VARIANT`, `BILLING_MODE`, `APP_HANDLE`
- [ ] Render build command runs `npx prisma migrate deploy`
- [ ] App Bridge script in root `<head>` confirmed (DevTools → Elements)
- [ ] Plan selection URL works manually:
      `https://admin.shopify.com/store/<dev-store>/charges/<handle>/pricing_plans`
- [ ] Fresh install on a dev store → install completes → home page renders
- [ ] Paywall banner visible on `/app` and on every gated route
- [ ] Click subscribe button → top-frame navigates to Shopify pricing page
- [ ] Subscribe to `$0` test plan → returns to app → Pro features unlock
- [ ] Reviewer notes filled in with credentials + step-by-step
- [ ] GDPR webhooks at `/webhooks/compliance` respond 200 with valid HMAC
- [ ] All locale keys present in `en.json` (English is what reviewers use)

---

## 16. Porting to a new app

Copy these files verbatim and rename plan names:

```
app/utils/billing.constants.js
app/utils/billing.server.js
app/routes/app.billing.jsx
app/routes/app.billing.subscribe.jsx
app/locales/{en,es}.json    # billing.* keys
```

Add the App Bridge script to `app/root.jsx` and the `afterAuth` try/catch
wraps to `app/shopify.server.js`.

Configure env vars + TOML handle + Partner Dashboard pricing.

Search the codebase for `PLAN_PRO` to find every place that gates features —
each one needs a paywall banner using the pattern from §8.
