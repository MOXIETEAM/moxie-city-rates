import { authenticate } from "../shopify.server";
import { PLAN_PRO } from "../utils/billing.constants";
import { resolveBillingTestMode } from "../utils/billing.server";
import { error as logError } from "../utils/logger.server";

/**
 * BILLING_MODE selects which Shopify billing flow this deployment uses:
 *
 *   - "managed" (Shopify App Pricing / Managed Pricing): plans are configured
 *     entirely in the Partner Dashboard and merchants select them via a
 *     Shopify-hosted plan selection page. The Billing API mutations are
 *     forbidden — calling appSubscriptionCreate returns
 *     "Managed Pricing Apps cannot use the Billing API (to create charges)."
 *     The action redirects the merchant to admin.shopify.com/.../pricing_plans.
 *
 *   - "api" (legacy Billing API): the app creates the charge itself via
 *     appSubscriptionCreate and the merchant approves a confirmationUrl. Used
 *     by the legacy Fletix deploy that still controls its own pricing.
 *
 * Default: "api" so the legacy Fletix deploy keeps working without a new env
 * var. Public listings MUST set BILLING_MODE=managed.
 */
function getBillingMode() {
  return process.env.BILLING_MODE === "managed" ? "managed" : "api";
}

/**
 * Resolves the app handle for Managed Pricing plan selection URLs. The handle
 * is the slug declared as `handle = "..."` in shopify.app.<config>.toml. It is
 * registered with Shopify via `shopify app deploy` and used to build the URL
 * `admin.shopify.com/store/<store>/charges/<handle>/pricing_plans`.
 *
 * Order of resolution:
 *   1. APP_HANDLE env var (explicit override, set per deploy)
 *   2. GraphQL currentAppInstallation.app.handle (only returns a value after
 *      `shopify app deploy` has registered the handle and the app has been
 *      installed on the shop)
 *
 * Falls back to null when neither source is set, in which case the action
 * returns a structured error and the client surfaces it inline. The error
 * message tells the operator exactly which env var to set.
 */
async function resolveAppHandle(admin) {
  const fromEnv = (process.env.APP_HANDLE || "").trim();
  if (fromEnv) return fromEnv;

  try {
    const res = await admin.graphql(`#graphql
      query FletixAppHandleLookup {
        currentAppInstallation {
          app {
            handle
          }
        }
      }
    `);
    const json = await res.json();
    const handle = json?.data?.currentAppInstallation?.app?.handle;
    if (handle) return handle;
    logError(
      "[billing.subscribe] currentAppInstallation.app.handle returned null — set APP_HANDLE env var to the value of `handle` in shopify.app.<config>.toml",
      json,
    );
    return null;
  } catch (e) {
    logError("[billing.subscribe] app handle lookup failed:", e?.message || e);
    return null;
  }
}

function buildPlanSelectionUrl(shopDomain, appHandle) {
  const storeHandle = (shopDomain || "").replace(/\.myshopify\.com$/, "");
  if (!storeHandle || !appHandle) return null;
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

/**
 * Subscription creation endpoint — action-only (POST).
 *
 * Returns JSON { confirmationUrl } so the client can perform the top-frame
 * redirect inside the original click handler, while the browser's transient
 * activation is still alive. Performing the redirect from a script loaded after
 * a separate navigation hop is blocked by `allow-top-navigation-by-user-activation`
 * in the Shopify admin iframe sandbox — which is why prior attempts that
 * returned HTML or used React Router fetcher.submit + useEffect failed silently.
 *
 * The GraphQL mutation is called directly so we never depend on the SDK's
 * throw-Response semantics or App Bridge's fetch interceptor.
 */

const APP_SUBSCRIPTION_CREATE = `#graphql
  mutation FletixAppSubscriptionCreate(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
  ) {
    appSubscriptionCreate(
      name: $name
      lineItems: $lineItems
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
      replacementBehavior: STANDARD
    ) {
      appSubscription { id name status test trialDays }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const PLAN_PRO_AMOUNT = 19.99;
const PLAN_PRO_CURRENCY = "USD";
const PLAN_PRO_INTERVAL = "EVERY_30_DAYS";
const PLAN_PRO_TRIAL_DAYS = 7;

export const action = async ({ request }) => {
  // Top-level try/catch returns a 200 JSON envelope on any failure so React
  // Router's global ErrorBoundary never fires for billing requests. The
  // client-side handler reads `success`/`error` and shows an inline message
  // — a 500 response triggers React Router's "Unexpected Server Error" screen
  // and Shopify App Review treats that as a hard rejection signal.
  try {
    const { billing, session, admin } = await authenticate.admin(request);

    const billingMode = getBillingMode();

    // Managed Pricing apps cannot call appSubscriptionCreate — Shopify rejects
    // with "Managed Pricing Apps cannot use the Billing API". Redirect the
    // merchant to the Shopify-hosted plan selection page instead. The client
    // navigates window.top.location to the URL we return as confirmationUrl.
    if (billingMode === "managed") {
      const appHandle = await resolveAppHandle(admin);
      const planSelectionUrl = buildPlanSelectionUrl(session.shop, appHandle);
      if (!planSelectionUrl) {
        logError(
          "[billing.subscribe] managed mode but app handle could not be resolved",
          { shop: session.shop, appHandle },
        );
        return {
          success: false,
          error: "Could not resolve the app handle from Shopify",
        };
      }
      return { success: true, confirmationUrl: planSelectionUrl, managed: true };
    }

    const isTest = await resolveBillingTestMode(admin);
    const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
    const returnUrl = appUrl ? `${appUrl}/app/billing` : undefined;

    if (!returnUrl) {
      logError("[billing.subscribe] SHOPIFY_APP_URL not configured");
      return { success: false, error: "App URL not configured" };
    }

    try {
      const existing = await billing.check({ plans: [PLAN_PRO], isTest });
      if (existing.hasActivePayment) {
        return { success: true, alreadyActive: true };
      }
    } catch (e) {
      logError("[billing.subscribe] check failed:", e?.message || e);
    }

    try {
      const res = await admin.graphql(APP_SUBSCRIPTION_CREATE, {
        variables: {
          name: PLAN_PRO,
          returnUrl,
          test: isTest,
          trialDays: PLAN_PRO_TRIAL_DAYS,
          lineItems: [
            {
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: PLAN_PRO_AMOUNT, currencyCode: PLAN_PRO_CURRENCY },
                  interval: PLAN_PRO_INTERVAL,
                },
              },
            },
          ],
        },
      });
      const json = await res.json();
      if (json.errors?.length) {
        logError("[billing.subscribe] GraphQL errors:", json.errors);
        return {
          success: false,
          error: json.errors.map((e) => e.message).join("; "),
        };
      }
      const payload = json?.data?.appSubscriptionCreate;
      const userErrors = payload?.userErrors ?? [];
      if (userErrors.length > 0) {
        logError("[billing.subscribe] userErrors:", userErrors);
        return {
          success: false,
          error: userErrors.map((e) => e.message).join("; "),
        };
      }
      const confirmationUrl = payload?.confirmationUrl;
      if (!confirmationUrl) {
        logError("[billing.subscribe] missing confirmationUrl:", json);
        return { success: false, error: "Missing confirmationUrl from Shopify" };
      }
      return { success: true, confirmationUrl };
    } catch (e) {
      logError("[billing.subscribe] graphql exception:", e?.message || e);
      return {
        success: false,
        error: e?.message || "Subscription request failed",
      };
    }
  } catch (e) {
    logError("[billing.subscribe] unhandled exception:", e?.message || e, e?.stack);
    return { success: false, error: e?.message || "Subscription request failed" };
  }
};

export default function Subscribe() {
  return null;
}
