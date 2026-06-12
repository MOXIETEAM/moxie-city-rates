// Plan identifiers passed to Shopify Billing API. Shopify matches by exact
// string, so changing these for a deployment that already has active
// subscriptions will detach them. Variant-aware so the public listing shows
// generic "Pro" while the legacy Fletix deploy keeps its existing plan name.
//
// IMPORTANT: this module is imported by both server and client code. In the
// browser, `process` is undefined and accessing `process.env.X` throws a
// ReferenceError that breaks React hydration and silently disables every
// button in the app. Use Vite's `import.meta.env` for the client-safe value
// and fall back to `process.env` on the server so a single .env source still
// works in dev. Both `VITE_APP_VARIANT` and `APP_VARIANT` should be set to
// the same value in each deployment so server and client stay consistent —
// if they diverge, `planInfo.plan === PLAN_PRO` comparisons on the client
// will silently mismatch the active subscription.
const APP_VARIANT =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_APP_VARIANT) ||
  // eslint-disable-next-line no-undef
  (typeof process !== "undefined" && process.env?.APP_VARIANT) ||
  "";

import { isDeliveryRules } from "./variant";

const isCityRates = isDeliveryRules(APP_VARIANT);

export const PLAN_FREE = isCityRates ? "Free" : "Fletix Free";
export const PLAN_PRO = isCityRates ? "Pro" : "Fletix Pro";
