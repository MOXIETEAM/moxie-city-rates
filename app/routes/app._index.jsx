import { useLoaderData, useNavigate, useOutletContext, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createTranslator } from "../utils/i18n";
import { getShopPlan, getBillingMode } from "../utils/billing.server";
import prisma from "../db.server";
import { error as logError } from "../utils/logger.server";
import { CARRIER_NAME } from "../utils/carrier-service.server";
import { PLAN_FREE, PLAN_PRO } from "../utils/billing.constants";

/** Detecta si el carrier de la app está registrado y activo en la tienda (Admin API). */
async function checkCarrierRegistered(admin) {
  try {
    const res = await admin.graphql(`
      query CarrierServicesCheck {
        carrierServices(first: 20) {
          nodes { id name active }
        }
      }
    `);
    const json = await res.json();
    const nodes = json.data?.carrierServices?.nodes ?? [];
    return nodes.some((c) => c.name === CARRIER_NAME && c.active !== false);
  } catch (err) {
    logError("[app._index] checkCarrierRegistered:", err);
    return false;
  }
}

export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Each external dependency is wrapped so a transient failure renders a
  // degraded home page instead of a 500. Shopify App Review will reject the
  // app on any uncaught 500 it observes during the install or onboarding flow.
  let planInfo;
  try {
    planInfo = await getShopPlan(billing, shop, admin);
  } catch (e) {
    logError("[index loader] getShopPlan failed:", e?.message || e);
    planInfo = { plan: PLAN_FREE, limits: {}, sponsored: false, subscription: null };
  }

  let zoneCount = 0;
  let rateCount = 0;
  let zones = [];
  let hasCarrierRegistered = false;
  try {
    [zoneCount, rateCount, zones, hasCarrierRegistered] = await Promise.all([
      prisma.shippingZone.count({ where: { shop } }).catch(() => 0),
      prisma.shippingRate.count({ where: { zone: { shop } } }).catch(() => 0),
      prisma.shippingZone
        .findMany({
          where: { shop },
          include: { rates: { select: { serviceCode: true, pricingMode: true } } },
          orderBy: { department: "asc" },
        })
        .catch(() => []),
      checkCarrierRegistered(admin),
    ]);
  } catch (e) {
    logError("[index loader] Promise.all failed:", e?.message || e);
  }

  const serviceCounts = {};
  let weightTierCount = 0;
  let cartTotalCount = 0;
  for (const zone of zones) {
    for (const rate of zone.rates) {
      serviceCounts[rate.serviceCode] = (serviceCounts[rate.serviceCode] || 0) + 1;
      if (rate.pricingMode === "weight_tiers") weightTierCount++;
      if (rate.pricingMode === "cart_total") cartTotalCount++;
    }
  }

  const hasDefault = zones.some((z) => z.slug === "_default" && z.rates.length > 0);
  const departments = zones
    .filter((z) => z.slug !== "_default")
    .map((z) => z.department);

  const docsUrl =
    process.env.APP_DOCS_URL?.trim() || "https://shopify.dev/docs/apps/build";

  // Pre-compute the Managed Pricing plan selection URL server-side so the home
  // banner CTA can be a plain `<a target="_top">`. See app.billing.jsx loader
  // for the rationale.
  const billingMode = getBillingMode();
  let planSelectionUrl = null;
  if (billingMode === "managed") {
    const appHandle = (process.env.APP_HANDLE || "").trim();
    const storeHandle = (shop || "").replace(/\.myshopify\.com$/, "");
    if (appHandle && storeHandle) {
      planSelectionUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
    }
  }

  return {
    shop,
    zoneCount,
    rateCount,
    serviceCounts,
    departments,
    hasDefault,
    weightTierCount,
    cartTotalCount,
    planSelectionUrl,
    billingMode,
    planName: planInfo.plan,
    docsUrl,
    hasCarrierRegistered,
  };
};

const ACCENT = "#47C1AF";
const PAGE_BG = "#F6F6F7";
const CARD_SHADOW = "0 2px 12px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04)";
const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const ICONS = {
  zone: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10A15 15 0 0 1 12 2z" />
    </svg>
  ),
  rate: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  plan: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  ),
  arrow: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
    </svg>
  ),
  external: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
};

function MetricCard({ icon, value, label, sub }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 18,
        padding: "22px 22px",
        minWidth: 0,
        flex: "1 1 200px",
        boxShadow: CARD_SHADOW,
        display: "flex",
        gap: 16,
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "rgba(71, 193, 175, 0.14)",
          color: ACCENT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.07em",
            color: "#8c9196",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#111213", lineHeight: 1.1 }}>{value}</div>
        {sub ? <div style={{ fontSize: 13, color: "#8c9196", marginTop: 8 }}>{sub}</div> : null}
      </div>
    </div>
  );
}

function SetupStep({ done, label, desc, actionLabel, onAction }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        padding: "16px 18px",
        borderRadius: 14,
        background: done ? "linear-gradient(135deg, #ecfdf7 0%, #f0fdf9 100%)" : "#fff",
        border: done ? "1px solid rgba(71, 193, 175, 0.22)" : "1px solid #e8e9eb",
        marginBottom: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, minWidth: 0 }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: done ? ACCENT : "#fff",
            border: done ? "none" : "2px solid #c9cccf",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {done ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#d2d5d8" }} />
          )}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#111213" }}>{label}</div>
          <div style={{ fontSize: 13, color: "#6d7175", marginTop: 4, lineHeight: 1.45 }}>{desc}</div>
        </div>
      </div>
      {!done && actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "4px 0",
            cursor: "pointer",
            font: "inherit",
            fontSize: 13,
            fontWeight: 600,
            color: ACCENT,
            display: "flex",
            alignItems: "center",
            gap: 4,
            whiteSpace: "nowrap",
          }}
        >
          {actionLabel}
          {ICONS.arrow}
        </button>
      ) : null}
    </div>
  );
}

export default function Index() {
  const data = useLoaderData();
  const { locale } = useOutletContext();
  const t = createTranslator(locale);
  const navigate = useNavigate();

  const hasZones = data.zoneCount > 0;

  const serviceLabels = {
    mox_express: t("home.service_express"),
    mox_envio: t("home.service_envio"),
    mox_pickup: t("home.service_pickup"),
  };

  const pricingSubLabel = [];
  if (data.weightTierCount > 0) pricingSubLabel.push(t("home.by_weight").replace("{{n}}", data.weightTierCount));
  if (data.cartTotalCount > 0) pricingSubLabel.push(t("home.by_amount").replace("{{n}}", data.cartTotalCount));

  const isPro = data.planName === PLAN_PRO;
  const planShort = isPro ? t("home.plan_pro_short") : t("home.plan_inactive_short");
  const planSub = isPro ? t("home.plan_pro_sub") : t("home.plan_inactive_sub");

  const setupTotal = 3;
  const setupDone =
    (hasZones ? 1 : 0) + (data.hasDefault ? 1 : 0) + (data.hasCarrierRegistered ? 1 : 0);
  const setupPct = Math.round((setupDone / setupTotal) * 100);

  const goRules = () => navigate("/app/shipping-rules");

  return (
    <div
      style={{
        fontFamily: FONT,
        background: PAGE_BG,
        minHeight: "100%",
        margin: 0,
        padding: "28px 20px 48px",
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        {/* Banner */}
        <div
          style={{
            background: "linear-gradient(125deg, #e6faf5 0%, #e8f4fc 55%, #eef6ff 100%)",
            borderRadius: 20,
            padding: "28px 32px",
            marginBottom: 24,
            boxShadow: CARD_SHADOW,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
          }}
        >
          <div style={{ maxWidth: 560 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: "#111213", margin: 0, letterSpacing: "-0.02em" }}>
              {t("home.welcome_title")}
            </h1>
            <p style={{ fontSize: 15, color: "#4a4d51", margin: "12px 0 0", lineHeight: 1.55 }}>
              {t("home.welcome_subtitle")}
            </p>
            <p style={{ fontSize: 13, color: "#6d7175", margin: "8px 0 0" }}>{data.shop}</p>
          </div>
        </div>

        {/* Paywall banner — visible until merchant subscribes (excluded for sponsored Pro). */}
        {!isPro && (
          <div
            style={{
              background: "linear-gradient(135deg, #fff7ed, #fde8d1)",
              border: "1px solid #f1c889",
              borderRadius: 16,
              padding: "20px 24px",
              marginBottom: 24,
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            <div style={{ maxWidth: 540 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#7c3a0c", margin: 0 }}>
                {t("billing.needs_subscription_title")}
              </div>
              <p style={{ fontSize: 14, color: "#7c3a0c", margin: "6px 0 0", lineHeight: 1.5 }}>
                {t("billing.needs_subscription_desc")}
              </p>
            </div>
            {data.billingMode === "managed" && data.planSelectionUrl ? (
              // Native top-frame nav to admin.shopify.com pricing page. Same
              // origin as the parent Shopify Admin frame, so target="_top"
              // works directly without fetch+JSON plumbing.
              <a
                href={data.planSelectionUrl}
                target="_top"
                rel="noopener noreferrer"
                style={{
                  display: "inline-block",
                  padding: "12px 22px",
                  background: "#bf5b16",
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                  textDecoration: "none",
                }}
              >
                {t("billing.needs_subscription_cta")}
              </a>
            ) : (
              // api / custom modes: route to the billing page where the subscribe
              // flow lives (App Bridge-aware fetcher for custom, confirmationUrl
              // redirect for api). Doing the subscribe fetch from here hit an
              // auth redirect that returned HTML instead of JSON. One source of
              // truth for subscribing, works the same across all billing modes.
              <button
                type="button"
                onClick={() => navigate("/app/billing")}
                style={{
                  display: "inline-block",
                  padding: "12px 22px",
                  background: "#bf5b16",
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {t("billing.needs_subscription_cta")}
              </button>
            )}
          </div>
        )}

        {/* Métricas */}
        <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
          <MetricCard icon={ICONS.zone} value={data.zoneCount} label={t("home.metric_zones")} />
          <MetricCard icon={ICONS.plan} value={planShort} label={t("home.metric_plan")} sub={planSub} />
          <MetricCard
            icon={ICONS.rate}
            value={data.rateCount}
            label={t("home.metric_rates")}
            sub={pricingSubLabel.length ? pricingSubLabel.join(" · ") : t("home.metric_rates_hint")}
          />
        </div>

        {/* Configuración inicial + barra */}
        <div
          style={{
            background: "#fff",
            borderRadius: 20,
            padding: "24px 26px 20px",
            marginBottom: 24,
            boxShadow: CARD_SHADOW,
            border: "1px solid rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#111213" }}>{t("home.setup_title")}</div>
              <div style={{ fontSize: 14, color: "#6d7175", marginTop: 6, maxWidth: 640 }}>{t("home.setup_desc")}</div>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: ACCENT }}>
              {t("home.setup_progress").replace("{{done}}", String(setupDone)).replace("{{total}}", String(setupTotal))}
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: "#e8e9eb", marginBottom: 18, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${setupPct}%`,
                borderRadius: 999,
                background: `linear-gradient(90deg, ${ACCENT}, #3db8a5)`,
                transition: "width 0.35s ease",
              }}
            />
          </div>
          <SetupStep
            done={hasZones}
            label={t("home.step_zones")}
            desc={t("home.step_zones_desc")}
            actionLabel={!hasZones ? t("home.step_action_rules") : undefined}
            onAction={!hasZones ? goRules : undefined}
          />
          <SetupStep
            done={data.hasDefault}
            label={t("home.step_default")}
            desc={t("home.step_default_desc")}
            actionLabel={hasZones && !data.hasDefault ? t("home.step_action_rules") : undefined}
            onAction={hasZones && !data.hasDefault ? goRules : undefined}
          />
          <SetupStep
            done={data.hasCarrierRegistered}
            label={t("home.step_carrier")}
            desc={t("home.step_carrier_desc")}
            actionLabel={!data.hasCarrierRegistered ? t("home.step_action_carrier") : undefined}
            onAction={!data.hasCarrierRegistered ? goRules : undefined}
          />
        </div>

        {/* Servicios */}
        <div
          style={{
            background: "#fff",
            borderRadius: 20,
            padding: "22px 26px",
            marginBottom: 24,
            boxShadow: CARD_SHADOW,
            border: "1px solid rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: "#111213", marginBottom: 14 }}>{t("home.services_title")}</div>
          {Object.keys(data.serviceCounts).length === 0 ? (
            <div style={{ fontSize: 14, color: "#8c9196", padding: "6px 0 4px" }}>{t("home.no_rates_warning")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(data.serviceCounts).map(([code, count]) => (
                <div
                  key={code}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px 14px",
                    background: "#f6f7f8",
                    borderRadius: 12,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500, color: "#202223" }}>{serviceLabels[code] || code}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#6d7175" }}>{t("home.rates_configured").replace("{{n}}", count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cobertura */}
        {data.departments.length > 0 && (
          <div
            style={{
              background: "#fff",
              borderRadius: 20,
              padding: "22px 26px",
              marginBottom: 24,
              boxShadow: CARD_SHADOW,
              border: "1px solid rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111213", marginBottom: 8 }}>{t("home.coverage_title")}</div>
            <div style={{ fontSize: 14, color: "#6d7175", marginBottom: 14 }}>{t("home.departments_active").replace("{{n}}", data.departments.length)}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {data.departments.map((dept) => (
                <span
                  key={dept}
                  style={{
                    fontSize: 12,
                    background: "rgba(71, 193, 175, 0.12)",
                    color: "#0d6b5c",
                    padding: "5px 12px",
                    borderRadius: 999,
                    fontWeight: 600,
                  }}
                >
                  {dept}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Acción rápida */}
        <div
          style={{
            background: "#fff",
            borderRadius: 20,
            padding: "22px 26px",
            marginBottom: 24,
            boxShadow: CARD_SHADOW,
            border: "1px solid rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: "#111213", marginBottom: 12 }}>{t("home.quick_actions")}</div>
          <button
            type="button"
            onClick={goRules}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 18px",
              background: "#f6f7f8",
              borderRadius: 14,
              cursor: "pointer",
              border: "1px solid #e8e9eb",
              width: "100%",
              textAlign: "left",
              font: "inherit",
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#111213" }}>{t("home.action_rules")}</div>
              <div style={{ fontSize: 13, color: "#6d7175", marginTop: 4 }}>{t("home.action_rules_desc")}</div>
            </div>
            <span style={{ color: ACCENT }}>{ICONS.arrow}</span>
          </button>
        </div>

        {/* Cómo funciona */}
        <div
          style={{
            background: "#fff",
            borderRadius: 20,
            padding: "22px 26px",
            boxShadow: CARD_SHADOW,
            border: "1px solid rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: "#111213", marginBottom: 16 }}>{t("home.how_title")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {[
              { label: t("home.how_step1"), desc: t("home.how_step1_desc") },
              { label: t("home.how_step2"), desc: t("home.how_step2_desc") },
              { label: t("home.how_step3"), desc: t("home.how_step3_desc") },
            ].map((step, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 16,
                  padding: "14px 0",
                  borderBottom: i < 2 ? "1px solid #eef0f2" : "none",
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: "rgba(71, 193, 175, 0.14)",
                    color: "#0d6b5c",
                    fontSize: 14,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#111213" }}>{step.label}</div>
                  <div style={{ fontSize: 13, color: "#6d7175", marginTop: 4, lineHeight: 1.45 }}>{step.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
