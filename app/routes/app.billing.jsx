import { useState } from "react";
import { useLoaderData, useOutletContext, useRouteError, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLAN_FREE, PLAN_PRO } from "../utils/billing.constants";
import { getShopPlan, resolveBillingTestMode, PLAN_LIMITS } from "../utils/billing.server";
import { getLocale, createTranslator } from "../utils/i18n";
import { error as logError } from "../utils/logger.server";
import prisma from "../db.server";

// Loader must never throw. Any unhandled error becomes a 500 to the merchant
// (and to the Shopify App Review reviewer), which is an automatic rejection
// trigger. Each external dependency (Shopify billing API, Prisma) is wrapped so
// a transient failure renders a degraded billing page with safe defaults
// rather than a broken iframe.
export const loader = async ({ request }) => {
  const { billing, session, admin } = await authenticate.admin(request);

  let planInfo;
  try {
    planInfo = await getShopPlan(billing, session.shop, admin);
  } catch (e) {
    logError("[billing loader] getShopPlan failed:", e?.message || e);
    planInfo = {
      plan: PLAN_FREE,
      limits: PLAN_LIMITS[PLAN_FREE],
      sponsored: false,
      subscription: null,
    };
  }

  let zoneCount = 0;
  let rateCount = 0;
  try {
    [zoneCount, rateCount] = await Promise.all([
      prisma.shippingZone.count({ where: { shop: session.shop } }),
      prisma.shippingRate.count({ where: { zone: { shop: session.shop } } }),
    ]);
  } catch (e) {
    logError("[billing loader] usage count failed:", e?.message || e);
  }

  // Pre-compute the Managed Pricing plan selection URL server-side so the UI
  // can render a plain `<a target="_top">` link. Clicking the link triggers a
  // native top-frame navigation to admin.shopify.com — same origin as the
  // Shopify Admin parent frame, so no iframe sandbox / cross-origin issues, no
  // fetch+JSON parsing, no transient-activation timing. This is the only flow
  // that survives every variant of "App Bridge isn't loaded yet" or "server
  // returned HTML instead of JSON" that we hit with fetch-based subscribe.
  let planSelectionUrl = null;
  if (process.env.BILLING_MODE === "managed") {
    const appHandle = (process.env.APP_HANDLE || "").trim();
    const storeHandle = (session.shop || "").replace(/\.myshopify\.com$/, "");
    if (appHandle && storeHandle) {
      planSelectionUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
    } else {
      logError(
        "[billing loader] managed mode but APP_HANDLE or shop missing — set APP_HANDLE env var to the handle from shopify.app.<config>.toml",
        { appHandle, storeHandle },
      );
    }
  }

  return {
    planInfo,
    usage: { zones: zoneCount, rates: rateCount },
    planSelectionUrl,
    billingMode: process.env.BILLING_MODE === "managed" ? "managed" : "api",
  };
};

// Action wrapped in try/catch so any failure becomes a structured JSON response
// rather than a 500. Shopify App Review's automated checks treat any uncaught
// 500 during the reviewer's flow as an automatic rejection — defensive error
// handling here is mandatory.
export const action = async ({ request }) => {
  try {
    const { billing, session, admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const locale = getLocale(url.searchParams.get("locale"));
    const t = createTranslator(locale);
    const formData = await request.formData();
    const intent = formData.get("_intent");

    const isTest = await resolveBillingTestMode(admin);

    if (intent === "cancel_subscription") {
      let planInfo;
      try {
        planInfo = await getShopPlan(billing, session.shop, admin);
      } catch (e) {
        logError("[billing action] getShopPlan failed:", e?.message || e);
        return { success: false, error: "Could not read current plan" };
      }
      if (planInfo.sponsored && !planInfo.subscription) {
        return { success: false, error: t("billing.sponsored_cannot_downgrade") };
      }
      if (planInfo.subscription) {
        try {
          await billing.cancel({
            subscriptionId: planInfo.subscription.id,
            isTest,
            prorate: true,
          });
        } catch (e) {
          logError("[billing action] billing.cancel failed:", e?.message || e);
          return { success: false, error: e?.message || "Cancel failed" };
        }
      }
      return { success: true, message: t("billing.downgrade") };
    }

    // Unknown intent — return null so the loader stays untouched. Logged so
    // unexpected POSTs that would have caused a silent 500 surface in logs.
    logError("[billing action] unknown intent:", intent);
    return { success: false, error: `Unknown intent: ${intent || "(empty)"}` };
  } catch (e) {
    logError("[billing action] unhandled exception:", e?.message || e, e?.stack);
    // Return 200 with error payload so React Router does NOT trigger its
    // global ErrorBoundary (which renders a generic "Unexpected Server Error"
    // screen). The client-side UI shows the message inline instead.
    return { success: false, error: e?.message || "Action failed" };
  }
};

const CHECK_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00a47c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const LOCK_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8c9196" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

function FeatureRow({ label, included }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
      {included ? CHECK_ICON : LOCK_ICON}
      <span style={{ fontSize: 13, color: included ? "#202223" : "#8c9196" }}>{label}</span>
    </div>
  );
}

function PlanCard({ name, description, price, features, isCurrent, actionLabel, onAction, actionHref, highlight, loading, trialBadge, trialNote }) {
  return (
    <div
      style={{
        background: "white",
        border: highlight ? "2px solid #5c6ac4" : "1px solid #e1e3e5",
        borderRadius: 14,
        padding: "28px 24px",
        flex: 1,
        minWidth: 320,
        maxWidth: 460,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {trialBadge && (
        <div
          style={{
            position: "absolute",
            top: -14,
            left: "50%",
            transform: "translateX(-50%)",
            background: "linear-gradient(135deg, #00a47c, #008f6c)",
            color: "white",
            fontSize: 12,
            fontWeight: 700,
            padding: "5px 16px",
            borderRadius: 20,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            boxShadow: "0 4px 10px rgba(0, 164, 124, 0.35)",
            whiteSpace: "nowrap",
          }}
        >
          {trialBadge}
        </div>
      )}
      <div style={{ fontSize: 18, fontWeight: 700, color: "#202223", marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 13, color: "#637381", marginBottom: 16, minHeight: 36 }}>{description}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
        <span style={{ fontSize: 36, fontWeight: 800, color: "#202223" }}>{price}</span>
        {price !== "$0" && <span style={{ fontSize: 14, color: "#637381" }}>USD /mes</span>}
      </div>
      {trialNote && (
        <div
          style={{
            background: "#e6f7f1",
            color: "#006b51",
            border: "1px solid #b6e8d6",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 20,
            textAlign: "center",
          }}
        >
          {trialNote}
        </div>
      )}
      <div style={{ flex: 1, marginBottom: 20 }}>
        {features.map((f, i) => (
          <FeatureRow key={i} label={f.label} included={f.included} />
        ))}
      </div>
      {isCurrent ? (
        <div
          style={{
            textAlign: "center",
            padding: "10px 0",
            fontSize: 14,
            fontWeight: 600,
            color: "#637381",
            border: "1px solid #e1e3e5",
            borderRadius: 8,
            background: "#f9fafb",
          }}
        >
          {actionLabel}
        </div>
      ) : actionHref ? (
        // Native top-frame navigation to admin.shopify.com pricing page. Same
        // origin as the parent Shopify Admin frame, so target="_top" works
        // without any iframe sandbox or session token plumbing. No fetch, no
        // JSON parsing, no race conditions — the only flow that can't return
        // "HTML instead of JSON" because there's no JSON involved.
        <a
          href={actionHref}
          target="_top"
          rel="noopener noreferrer"
          style={{
            display: "block",
            textAlign: "center",
            padding: "10px 0",
            fontSize: 14,
            fontWeight: 600,
            color: highlight ? "white" : "#202223",
            background: highlight ? "#5c6ac4" : "white",
            border: highlight ? "none" : "1px solid #e1e3e5",
            borderRadius: 8,
            textDecoration: "none",
            width: "100%",
          }}
        >
          {actionLabel}
        </a>
      ) : (
        <button
          type="button"
          onClick={onAction}
          disabled={loading}
          style={{
            padding: "10px 0",
            fontSize: 14,
            fontWeight: 600,
            color: highlight ? "white" : "#202223",
            background: highlight ? "#5c6ac4" : "white",
            border: highlight ? "none" : "1px solid #e1e3e5",
            borderRadius: 8,
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.7 : 1,
            width: "100%",
          }}
        >
          {loading ? "..." : actionLabel}
        </button>
      )}
    </div>
  );
}

export default function BillingPage() {
  const { planInfo, usage, planSelectionUrl, billingMode } = useLoaderData();
  const { locale } = useOutletContext();
  const t = createTranslator(locale);
  const fetcher = useFetcher();
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState(null);

  const isPro = planInfo.plan === PLAN_PRO;
  const loading = fetcher.state !== "idle" || subscribing;
  const sponsoredOnlyPro = Boolean(planInfo.sponsored && !planInfo.subscription);

  // Top-frame redirect must happen inside this async handler so the click's
  // transient activation is still alive when we set window.top.location. The
  // Shopify admin iframe sandbox uses `allow-top-navigation-by-user-activation`,
  // so a redirect from a useEffect or post-navigation script is blocked. fetch
  // is awaited once — activation persists across that single await — and the
  // top redirect runs as the next synchronous statement.
  const handleStartTrial = async () => {
    if (subscribing) return;
    setSubscribing(true);
    setSubscribeError(null);
    try {
      const res = await fetch("/app/billing/subscribe", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      // Parse defensively: an auth redirect returns HTML, not JSON, and a raw
      // `res.json()` would throw an "Unexpected token '<'" error that the
      // caller can't recover from. Read as text first, then JSON-parse.
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setSubscribeError(
          `Server returned HTML instead of JSON (HTTP ${res.status}). Likely an auth redirect — refresh and try again.`,
        );
        setSubscribing(false);
        return;
      }
      if (data.confirmationUrl) {
        const top = window.top || window.parent || window;
        try {
          top.location.href = data.confirmationUrl;
        } catch {
          window.location.href = data.confirmationUrl;
        }
        return;
      }
      if (data.alreadyActive) {
        window.location.reload();
        return;
      }
      setSubscribeError(data.error || "Subscription failed");
      setSubscribing(false);
    } catch (e) {
      setSubscribeError(e?.message || "Network error");
      setSubscribing(false);
    }
  };

  const proFeatures = [
    { label: t("billing.feature_zones_unlimited"), included: true },
    { label: t("billing.feature_rates_unlimited"), included: true },
    { label: t("billing.feature_flat"), included: true },
    { label: t("billing.feature_carrier"), included: true },
    { label: t("billing.feature_fuzzy"), included: true },
    { label: t("billing.feature_metafield"), included: true },
    { label: t("billing.feature_rate_calculator"), included: true },
    { label: t("billing.feature_weight"), included: true },
    { label: t("billing.feature_cart"), included: true },
    { label: t("billing.feature_schedule"), included: true },
    { label: t("billing.feature_csv"), included: true },
    { label: t("billing.feature_product_tags"), included: true },
  ];

  const handleDowngrade = () => {
    if (sponsoredOnlyPro) {
      window.alert(t("billing.sponsored_cannot_downgrade"));
      return;
    }
    if (confirm(t("billing.downgrade") + "?")) {
      fetcher.submit({ _intent: "cancel_subscription" }, { method: "POST" });
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px", fontFamily: "Inter, sans-serif" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#202223", margin: 0 }}>{t("billing.title")}</h1>
        <p style={{ fontSize: 14, color: "#637381", margin: "6px 0 0" }}>{t("billing.subtitle")}</p>
      </div>

      {/* Current plan banner */}
      <div
        style={{
          background: isPro ? "linear-gradient(135deg, #f0f0ff, #e8e8ff)" : "#fff7ed",
          border: "1px solid #e1e3e5",
          borderRadius: 12,
          padding: "16px 24px",
          marginBottom: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 13, color: "#637381" }}>{t("billing.current_plan")}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: isPro ? "#5c6ac4" : "#bf5b16" }}>
            {isPro ? t("billing.pro_name") : t("billing.not_subscribed")}
            {planInfo.sponsored && (
              <span style={{ fontSize: 13, fontWeight: 500, color: "#637381", marginLeft: 8 }}>
                ({t("billing.sponsored_badge")})
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, color: "#637381" }}>
            {t("billing.usage_line", { zones: usage.zones, rates: usage.rates })}
          </div>
          {planInfo.subscription?.test && (
            <div style={{ fontSize: 11, color: "#bf5b16", marginTop: 2 }}>Test mode</div>
          )}
        </div>
      </div>

      {(fetcher.data?.error || subscribeError) && (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: 12,
            padding: "12px 16px",
            marginBottom: 16,
            color: "#991b1b",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {subscribeError || fetcher.data?.error}
        </div>
      )}

      {/* Trial banner — only while Shopify reports a live trial window. */}
      {planInfo.subscription?.trial?.active && (
        <div
          style={{
            background: "#e6f7f1",
            border: "1px solid #b6e8d6",
            borderRadius: 12,
            padding: "14px 20px",
            marginBottom: 24,
            color: "#006b51",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            🎁 {t("billing.trial_active")} — {planInfo.subscription.trial.daysLeft} {planInfo.subscription.trial.daysLeft === 1 ? "día" : "días"}
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {t("billing.trial_active_desc")}
          </div>
        </div>
      )}

      {/* Single Pro plan card. Managed Pricing uses a plain anchor with
          target="_top" to admin.shopify.com — native top-frame navigation that
          never depends on fetch/JSON/App Bridge interception. Legacy api mode
          falls back to the fetch+top.location handler. */}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <PlanCard
          name={t("billing.pro_name")}
          description={t("billing.pro_desc")}
          price="$19.99"
          features={proFeatures}
          isCurrent={isPro}
          actionLabel={isPro ? t("billing.downgrade") : t("billing.start_trial")}
          onAction={isPro ? handleDowngrade : billingMode === "managed" ? undefined : handleStartTrial}
          actionHref={!isPro && billingMode === "managed" ? planSelectionUrl : undefined}
          highlight={!isPro}
          loading={loading}
          trialBadge={!isPro ? t("billing.trial_badge") : undefined}
          trialNote={!isPro ? t("billing.trial_note") : undefined}
        />
      </div>

      {/* Trial info */}
      {!isPro && (
        <div
          style={{
            textAlign: "center",
            marginTop: 20,
            fontSize: 13,
            color: "#637381",
            padding: "12px 0",
          }}
        >
          {t("billing.trial_info")}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
