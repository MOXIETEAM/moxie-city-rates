import { PLAN_PRO, PLAN_FREE, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { normalizeShopDomain } from "./shop-record.server";
import { error as logError } from "./logger.server";

/**
 * Single-tier model: Pro is the only paid plan. Without an active subscription
 * (or sponsored access), the shop is in a "locked" state — limits are all zero
 * and the app forces the merchant to subscribe. PLAN_FREE is kept as the
 * identifier for that locked state so existing callers (`checkLimit`, etc) keep
 * working without a sweeping refactor.
 */
export const PLAN_LIMITS = {
  [PLAN_FREE]: {
    maxZones: 0,
    maxRatesPerZone: 0,
    weightTiers: false,
    cartTotalTiers: false,
    scheduleRestrictions: false,
    csvImportExport: false,
    productTagRates: false,
    storefrontRateCalculator: false,
  },
  [PLAN_PRO]: {
    maxZones: Infinity,
    maxRatesPerZone: Infinity,
    weightTiers: true,
    cartTotalTiers: true,
    scheduleRestrictions: true,
    csvImportExport: true,
    productTagRates: true,
    storefrontRateCalculator: true,
  },
};

/**
 * Returns true when billing should use test mode for this shop.
 *
 * Shopify rejects real charges on partner development stores. Reviewers and
 * partners install on dev stores, so we must pass `isTest: true` on those
 * regardless of NODE_ENV. Falls back to `NODE_ENV !== "production"` if the
 * shop plan lookup fails so local dev keeps working.
 */
export async function resolveBillingTestMode(admin) {
  if (process.env.NODE_ENV !== "production") return true;
  if (!admin) return false;
  try {
    const res = await admin.graphql(
      `query ShopPlanCheck { shop { plan { partnerDevelopment shopifyPlus } } }`,
    );
    const json = await res.json();
    return json?.data?.shop?.plan?.partnerDevelopment === true;
  } catch (e) {
    logError("[billing] resolveBillingTestMode:", e?.message || e);
    return false;
  }
}

/**
 * Pro patrocinado: `AppShop.sponsoredPro === true` (se edita en BD; la fila se crea al instalar la app).
 */
export async function isSponsoredProShop(shop) {
  const n = normalizeShopDomain(shop);
  if (!n) return false;
  try {
    const row = await prisma.appShop.findUnique({
      where: { shop: n },
      select: { sponsoredPro: true },
    });
    return row?.sponsoredPro === true;
  } catch (e) {
    logError("[billing] isSponsoredProShop:", e.message);
    return false;
  }
}

function proPlanResultFromSponsored() {
  return {
    plan: PLAN_PRO,
    limits: PLAN_LIMITS[PLAN_PRO],
    sponsored: true,
    subscription: null,
  };
}

/**
 * Pulls `createdAt` for active subscriptions so we can show trial status.
 * `billing.check()` doesn't expose createdAt, so fetch it directly.
 */
async function fetchSubscriptionMetadata(admin) {
  try {
    const res = await admin.graphql(`
      query ActiveSubsMeta {
        currentAppInstallation {
          activeSubscriptions {
            id
            createdAt
            trialDays
            currentPeriodEnd
          }
        }
      }
    `);
    const json = await res.json();
    return json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
  } catch (e) {
    logError("[billing] fetchSubscriptionMetadata:", e?.message || e);
    return [];
  }
}

function computeTrialStatus(meta) {
  if (!meta || meta.trialDays <= 0 || !meta.createdAt) return null;
  const createdAt = new Date(meta.createdAt);
  const trialEnd = new Date(createdAt.getTime() + meta.trialDays * 86400000);
  const now = Date.now();
  if (trialEnd.getTime() <= now) return null;
  const daysLeft = Math.max(0, Math.ceil((trialEnd.getTime() - now) / 86400000));
  return { active: true, trialEnd: trialEnd.toISOString(), daysLeft };
}

/** Resuelve el plan efectivo; `shop` (session.shop) habilita Pro patrocinado si no hay suscripción Shopify. */
export async function getShopPlan(billing, shop, admin) {
  const shopNorm = normalizeShopDomain(shop);
  const isTest = await resolveBillingTestMode(admin);

  try {
    const { hasActivePayment, appSubscriptions } = await billing.check({
      plans: [PLAN_PRO],
      isTest,
    });

    if (hasActivePayment && appSubscriptions.length > 0) {
      const sub = appSubscriptions[0];
      const metaList = admin ? await fetchSubscriptionMetadata(admin) : [];
      const meta = metaList.find((m) => m.id === sub.id) || metaList[0] || null;
      const trial = computeTrialStatus(meta);
      return {
        plan: PLAN_PRO,
        limits: PLAN_LIMITS[PLAN_PRO],
        sponsored: false,
        subscription: {
          id: sub.id,
          name: sub.name,
          test: sub.test,
          trialDays: sub.trialDays ?? meta?.trialDays ?? 0,
          currentPeriodEnd: sub.currentPeriodEnd ?? meta?.currentPeriodEnd ?? null,
          createdAt: meta?.createdAt ?? null,
          trial,
        },
      };
    }
  } catch (e) {
    logError("[billing] Error checking plan:", e.message);
  }

  if (shopNorm && (await isSponsoredProShop(shopNorm))) {
    return proPlanResultFromSponsored();
  }

  return {
    plan: PLAN_FREE,
    limits: PLAN_LIMITS[PLAN_FREE],
    sponsored: false,
    subscription: null,
  };
}

/** Plan para APIs públicas (p. ej. calculadora storefront) usando sesión offline de la tienda. */
export async function getShopPlanForStorefront(shopDomain) {
  if (!shopDomain || typeof shopDomain !== "string") {
    return { plan: PLAN_FREE, limits: PLAN_LIMITS[PLAN_FREE], subscription: null, sponsored: false };
  }
  const shopNorm = normalizeShopDomain(shopDomain);
  try {
    const { admin } = await unauthenticated.admin(shopDomain.trim());
    const response = await admin.graphql(`
      query FletixStorefrontPlanCheck {
        currentAppInstallation {
          activeSubscriptions {
            name
            status
          }
        }
      }
    `);
    const json = await response.json();
    if (json.errors?.length) {
      logError("[billing] getShopPlanForStorefront GraphQL:", json.errors);
    } else {
      const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
      const activePro = subs.some(
        (s) => s.status === "ACTIVE" && s.name === PLAN_PRO,
      );
      if (activePro) {
        return {
          plan: PLAN_PRO,
          limits: PLAN_LIMITS[PLAN_PRO],
          sponsored: false,
          subscription: subs.find((s) => s.status === "ACTIVE") ?? null,
        };
      }
    }
  } catch (e) {
    logError("[billing] getShopPlanForStorefront:", e.message);
  }

  if (await isSponsoredProShop(shopNorm)) {
    return { ...proPlanResultFromSponsored() };
  }

  return {
    plan: PLAN_FREE,
    limits: PLAN_LIMITS[PLAN_FREE],
    sponsored: false,
    subscription: null,
  };
}

export function checkLimit(planInfo, type, currentCount) {
  const { limits } = planInfo;

  switch (type) {
    case "zones":
      return currentCount < limits.maxZones;
    case "ratesPerZone":
      return currentCount < limits.maxRatesPerZone;
    case "weightTiers":
      return limits.weightTiers;
    case "cartTotalTiers":
      return limits.cartTotalTiers;
    case "schedule":
      return limits.scheduleRestrictions;
    case "csv":
      return limits.csvImportExport;
    case "productTags":
      return limits.productTagRates;
    case "storefrontRateCalculator":
      return limits.storefrontRateCalculator === true;
    default:
      return true;
  }
}
