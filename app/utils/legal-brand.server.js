import { isDeliveryRules } from "./variant";

/**
 * Brand resolution for public legal/support pages.
 * Driven by APP_VARIANT env so the same repo can serve both Fletix (private)
 * and Delivery Rules (public App Store) deployments.
 */

export function getLegalBrand() {
  const isCityRates = isDeliveryRules(process.env.APP_VARIANT);
  return {
    appName: isCityRates ? "Delivery Rules" : "Fletix",
    company: "Moxie",
    contactEmail: "info@moxiedigital.co",
    website: "https://moxiedigital.co",
    logoUrl:
      "https://www.moxiedigital.co/cdn/shop/files/Logo_Moxie_nuevo_banco_con_azul_rey.png?v=1772565807&width=320",
    appUrl:
      process.env.SHOPIFY_APP_URL ||
      (isCityRates
        ? "https://moxie-city-rates-public.onrender.com"
        : "https://moxie-city-rates-test.onrender.com"),
    formsubmitHash: process.env.FORMSUBMIT_HASH || "f8707cd07387279b53c2352ebe26c081",
    lastUpdated: "May 20, 2026",
  };
}
