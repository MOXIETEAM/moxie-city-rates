import { PLAN_PRO, PLAN_FREE, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { normalizeShopDomain } from "./shop-record.server";
import { error as logError } from "./logger.server";

/**
 * Matriz oficial Free vs Pro (debe coincidir con app/routes/app.billing.jsx y la UI).
 *
 * Free: hasta maxZones zonas, maxRatesPerZone tarifas por zona, solo precio fijo,
 * ciudad/homologación, sync storefront, carrier service.
 * Pro: además rangos por peso/monto, horarios, CSV, tarifas por tags, calculadora en storefront.
 */
export const PLAN_LIMITS = {
  [PLAN_FREE]: {
    maxZones: 3,
    maxRatesPerZone: 2,
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

/** Resuelve el plan efectivo; `shop` (session.shop) habilita Pro patrocinado si no hay suscripción Shopify. */
export async function getShopPlan(billing, shop) {
  const shopNorm = normalizeShopDomain(shop);

  try {
    const { hasActivePayment, appSubscriptions } = await billing.check({
      plans: [PLAN_PRO],
      isTest: process.env.NODE_ENV !== "production",
    });

    if (hasActivePayment && appSubscriptions.length > 0) {
      const sub = appSubscriptions[0];
      return {
        plan: PLAN_PRO,
        limits: PLAN_LIMITS[PLAN_PRO],
        sponsored: false,
        subscription: {
          id: sub.id,
          name: sub.name,
          test: sub.test,
          trialDays: sub.trialDays ?? 0,
          currentPeriodEnd: sub.currentPeriodEnd ?? null,
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
