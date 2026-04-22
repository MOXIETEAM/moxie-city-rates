import { useLoaderData, useOutletContext, useRouteError, useNavigate, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLAN_PRO, PLAN_FREE } from "../utils/billing.constants";
import { getShopPlan, PLAN_LIMITS } from "../utils/billing.server";
import { getLocale, createTranslator } from "../utils/i18n";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);

  const planInfo = await getShopPlan(billing, session.shop);
  const freeLimits = PLAN_LIMITS[PLAN_FREE];

  const [zoneCount, rateCount] = await Promise.all([
    prisma.shippingZone.count({ where: { shop: session.shop } }),
    prisma.shippingRate.count({ where: { zone: { shop: session.shop } } }),
  ]);

  return {
    planInfo,
    usage: { zones: zoneCount, rates: rateCount },
    freeLimits: { maxZones: freeLimits.maxZones, maxRatesPerZone: freeLimits.maxRatesPerZone },
  };
};

export const action = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const locale = getLocale(url.searchParams.get("locale"));
  const t = createTranslator(locale);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  if (intent === "subscribe_pro") {
    await billing.require({
      plans: [PLAN_PRO],
      isTest: process.env.NODE_ENV !== "production",
      onFailure: async () => {
        throw await billing.request({
          plan: PLAN_PRO,
          isTest: process.env.NODE_ENV !== "production",
        });
      },
    });
    return { success: true };
  }

  if (intent === "cancel_subscription") {
    const planInfo = await getShopPlan(billing, session.shop);
    if (planInfo.sponsored && !planInfo.subscription) {
      return { success: false, error: t("billing.sponsored_cannot_downgrade") };
    }
    if (planInfo.subscription) {
      await billing.cancel({
        subscriptionId: planInfo.subscription.id,
        isTest: process.env.NODE_ENV !== "production",
        prorate: true,
      });
    }
    return { success: true, message: t("billing.downgrade") };
  }

  return null;
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

function PlanCard({ name, description, price, features, isCurrent, actionLabel, onAction, highlight, loading }) {
  return (
    <div
      style={{
        background: "white",
        border: highlight ? "2px solid #5c6ac4" : "1px solid #e1e3e5",
        borderRadius: 14,
        padding: "28px 24px",
        flex: 1,
        minWidth: 280,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {highlight && (
        <div
          style={{
            position: "absolute",
            top: -12,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#5c6ac4",
            color: "white",
            fontSize: 11,
            fontWeight: 600,
            padding: "3px 14px",
            borderRadius: 20,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Popular
        </div>
      )}
      <div style={{ fontSize: 18, fontWeight: 700, color: "#202223", marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 13, color: "#637381", marginBottom: 16, minHeight: 36 }}>{description}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 20 }}>
        <span style={{ fontSize: 36, fontWeight: 800, color: "#202223" }}>{price}</span>
        {price !== "$0" && <span style={{ fontSize: 14, color: "#637381" }}>USD /mes</span>}
      </div>
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
  const { planInfo, usage, freeLimits } = useLoaderData();
  const { locale } = useOutletContext();
  const t = createTranslator(locale);
  const fetcher = useFetcher();
  const navigate = useNavigate();

  const isPro = planInfo.plan === PLAN_PRO;
  const loading = fetcher.state !== "idle";
  const sponsoredOnlyPro = Boolean(planInfo.sponsored && !planInfo.subscription);

  const freeFeatures = [
    { label: t("billing.feature_zones", { n: freeLimits.maxZones }), included: true },
    { label: t("billing.feature_rates", { n: freeLimits.maxRatesPerZone }), included: true },
    { label: t("billing.feature_flat"), included: true },
    { label: t("billing.feature_carrier"), included: true },
    { label: t("billing.feature_fuzzy"), included: true },
    { label: t("billing.feature_metafield"), included: true },
    { label: t("billing.feature_rate_calculator"), included: false },
    { label: t("billing.feature_weight"), included: false },
    { label: t("billing.feature_cart"), included: false },
    { label: t("billing.feature_schedule"), included: false },
    { label: t("billing.feature_csv"), included: false },
    { label: t("billing.feature_product_tags"), included: false },
  ];

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

  const handleUpgrade = () => {
    fetcher.submit({ _intent: "subscribe_pro" }, { method: "POST" });
  };

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
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px", fontFamily: "Inter, sans-serif" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#202223", margin: 0 }}>{t("billing.title")}</h1>
        <p style={{ fontSize: 14, color: "#637381", margin: "6px 0 0" }}>{t("billing.subtitle")}</p>
      </div>

      {/* Current plan banner */}
      <div
        style={{
          background: isPro ? "linear-gradient(135deg, #f0f0ff, #e8e8ff)" : "#f9fafb",
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
          <div style={{ fontSize: 18, fontWeight: 700, color: isPro ? "#5c6ac4" : "#202223" }}>
            {isPro ? t("billing.pro_name") : t("billing.free_name")}
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

      {/* Plan cards */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <PlanCard
          name={t("billing.free_name")}
          description={t("billing.free_desc")}
          price="$0"
          features={freeFeatures}
          isCurrent={!isPro}
          actionLabel={!isPro ? t("billing.current") : t("billing.downgrade")}
          onAction={handleDowngrade}
          highlight={false}
          loading={loading}
        />
        <PlanCard
          name={t("billing.pro_name")}
          description={t("billing.pro_desc")}
          price="$19.99"
          features={proFeatures}
          isCurrent={isPro}
          actionLabel={isPro ? t("billing.current") : t("billing.upgrade")}
          onAction={handleUpgrade}
          highlight={!isPro}
          loading={loading}
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
