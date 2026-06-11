/**
 * Geo + currency helpers — isomorphic (server + client).
 *
 * Replaces the Colombia-only PROVINCE_CODE_TO_SLUG / SLUG_TO_DEPARTMENT maps
 * and the hardcoded "COP" / es-CO formatting that were scattered across the
 * carrier service, rate calculator, and admin UI.
 *
 * Zone-matching contract (must stay consistent between admin write and
 * checkout read):
 *   zone.slug === toSlug(subdivisionDisplayName)
 * At checkout Shopify sends `destination.province` as a CODE (e.g. "ANT",
 * "CA"). `provinceToSlug(country, province)` resolves that code → display name
 * via the dataset, then toSlug()s it — landing on the same slug the admin
 * stored. If Shopify ever sends the full name instead of the code, the
 * fallback toSlug(province) still lands on the same value.
 */

import SUBDIVISIONS from "../data/subdivisions.json";

/** Stable slug. Identical algorithm to mox-shipping-rules.server.toSlug. */
export function toSlug(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Country whose zones default to the legacy Colombian behavior. */
export const DEFAULT_COUNTRY = "CO";

/** ISO 4217 codes with zero minor units — Intl handles display, but the
 *  carrier `total_price` hundredths convention needs the right rounding. */
const ZERO_DECIMAL_CURRENCIES = new Set(["COP", "CLP", "JPY", "KRW", "PYG", "VND", "ISK", "HUF"]);

/** Supported countries for the admin selector: [{ code, name, currency }]. */
export function getCountries() {
  return Object.entries(SUBDIVISIONS).map(([code, v]) => ({
    code,
    name: v.name,
    currency: v.currency,
  }));
}

export function isSupportedCountry(country) {
  return Boolean(country && SUBDIVISIONS[country]);
}

/** Subdivisions for a country as [{ code, name, slug }]. Empty if unknown. */
export function getSubdivisions(country) {
  const entry = SUBDIVISIONS[country];
  if (!entry) return [];
  return entry.subdivisions.map((s) => ({
    code: s.code,
    name: s.name,
    slug: toSlug(s.name),
  }));
}

/** Default currency for a country (from the dataset), or null if unknown. */
export function currencyForCountry(country) {
  return SUBDIVISIONS[country]?.currency ?? null;
}

/**
 * Resolve a checkout province value (code or name) to the zone slug.
 * @param {string} country ISO 3166-1 alpha-2 (destination country)
 * @param {string} province Shopify `destination.province` (usually the code)
 */
export function provinceToSlug(country, province) {
  if (!province) return null;
  const entry = SUBDIVISIONS[country];
  if (entry) {
    const upper = String(province).toUpperCase();
    const byCode = entry.subdivisions.find((s) => s.code.toUpperCase() === upper);
    if (byCode) return toSlug(byCode.name);
  }
  // Country not in dataset, or province sent as a name → slug it directly.
  return toSlug(province);
}

// --- Multi-país: slugs de zona con prefijo de país ---
//
// Contrato: zonas de Colombia conservan el slug histórico sin prefijo
// ("antioquia") — themes desplegados y filas existentes no se tocan. Zonas de
// cualquier otro país llevan prefijo ISO ("mx_jalisco", "us_california") para
// que subdivisiones homónimas de países distintos no colisionen (la llave de
// búsqueda es [shop, slug], sin país).

/** Prefijo de slug para un país ("" para CO, "mx_" para MX, etc.). */
export function zoneSlugPrefix(country) {
  return country && country !== DEFAULT_COUNTRY ? `${country.toLowerCase()}_` : "";
}

/** Slug de zona al CREAR: nombre de la subdivisión + prefijo de país. */
export function zoneSlugForCountry(country, departmentName) {
  return zoneSlugPrefix(country) + toSlug(departmentName);
}

/**
 * Slugs candidatos para buscar la zona de un destino en checkout, en orden de
 * prioridad: primero el prefijado (esquema nuevo), luego el legacy sin prefijo
 * (zonas no-CO creadas antes del prefijo). Para CO ambos coinciden → uno solo.
 */
export function provinceToZoneSlugCandidates(country, province) {
  const legacy = provinceToSlug(country, province);
  if (!legacy) return [];
  const prefixed = zoneSlugPrefix(country) + legacy;
  return prefixed === legacy ? [legacy] : [prefixed, legacy];
}

/**
 * Slug de la zona default que aplica a un país destino. El slug histórico
 * `_default` queda reservado para el país de la tienda; otros países usan
 * `_default_{cc}`. Un destino sin default propio NO cae al default de la
 * tienda — eso evitaba que un cliente en México recibiera la tarifa default
 * pensada para Colombia.
 */
export function defaultZoneSlugFor(destCountry, shopCountry) {
  const dest = destCountry || DEFAULT_COUNTRY;
  const home = shopCountry || DEFAULT_COUNTRY;
  return dest === home ? "_default" : `_default_${dest.toLowerCase()}`;
}

/** Display name for a province code, falling back to the raw value. */
export function provinceDisplayName(country, province) {
  if (!province) return "";
  const entry = SUBDIVISIONS[country];
  if (entry) {
    const upper = String(province).toUpperCase();
    const match = entry.subdivisions.find((s) => s.code.toUpperCase() === upper);
    if (match) return match.name;
  }
  return province;
}

/**
 * Format a money amount (in MAJOR units of `currency`) for display.
 * Falls back to a plain grouped number if the currency is unknown to Intl.
 */
export function formatMoney(amount, currency, locale) {
  const code = currency || "COP";
  const loc = locale || "es-CO";
  try {
    return new Intl.NumberFormat(loc, {
      style: "currency",
      currency: code,
      maximumFractionDigits: ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(loc)} ${code}`;
  }
}

/**
 * Convert a major-unit amount to the integer Shopify carrier `total_price`
 * expects. Shopify treats `total_price` as hundredths of the currency unit
 * across currencies (the legacy COP behavior multiplied by 100), so this is
 * `round(amount * 100)` universally.
 */
export function toCarrierTotalPrice(amount) {
  return String(Math.round((Number(amount) || 0) * 100));
}
