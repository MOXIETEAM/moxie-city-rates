// Plan identifiers passed to Shopify Billing API. Shopify matches by exact
// string, so changing these for a deployment that already has active
// subscriptions will detach them. Variant-aware so the public listing shows
// generic "Pro" while the legacy Fletix deploy keeps its existing plan name.
const isCityRates = process.env.APP_VARIANT === "cityrates";

export const PLAN_FREE = isCityRates ? "Free" : "Fletix Free";
export const PLAN_PRO = isCityRates ? "Pro" : "Fletix Pro";
