import { useFetcher, useLoaderData, useOutletContext, useRouteError, useSearchParams } from "react-router";
import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getZonesWithRates,
  createZone,
  deleteZone,
  saveRate,
  deleteRate,
  duplicateRate,
  getOrCreateDefaultZoneForCountry,
  syncRulesToMetafield,
  updateZoneEnabledServices,
  duplicateZoneTo,
} from "../mox-shipping-rules.server";
import { createTranslator, getLocale } from "../utils/i18n";
import { debug, error as logError } from "../utils/logger.server";
import { ensureFletixCarrierService } from "../utils/carrier-service.server";
import { detectEnabledServicesForDepartment, getServiceAvailabilityByProvince } from "../utils/locations.server";
import { getWarehouses } from "../utils/warehouse.server";
import { warehousesForRate } from "../utils/warehouse";
import { getShopPlan, checkLimit, PLAN_LIMITS, getBillingMode } from "../utils/billing.server";
import { PLAN_FREE, PLAN_PRO } from "../utils/billing.constants";
import { getShopMeta } from "../utils/shop-record.server";
import { getQuotes, createQuoteTrace, saveQuote, QUOTE_RETENTION_DAYS } from "../utils/quote-log.server";
import { quoteShipping } from "../rate-engine.server";
import { QuotesView } from "../components/quotes-ui";
import prisma from "../db.server";

import MUNICIPALITIES from "../data/municipalities.json";
import { getSubdivisions, isSupportedCountry, formatMoney, getCountries, zoneSlugForCountry } from "../utils/geo";

// Shop currency + subdivision list, provided once at the page root so the
// nested rate/zone components format money in the shop currency and offer the
// right regions without prop-drilling. Defaults keep the legacy CO behavior.
const ShopMetaContext = createContext({ currency: "COP", subdivisions: [], warehouses: [] });
function useShopCurrency() {
  return useContext(ShopMetaContext).currency || "COP";
}
function useWarehouses() {
  return useContext(ShopMetaContext).warehouses || [];
}

function getServiceCodes(t) {
  return [
    { value: "mox_envio", label: t("shipping.service_standard") },
    { value: "mox_express", label: t("shipping.service_express") },
    { value: "mox_pickup", label: t("shipping.service_pickup") },
  ];
}

function getDaysOfWeek(t) {
  return [
    { value: "mon", label: t("shipping.day_mon") },
    { value: "tue", label: t("shipping.day_tue") },
    { value: "wed", label: t("shipping.day_wed") },
    { value: "thu", label: t("shipping.day_thu") },
    { value: "fri", label: t("shipping.day_fri") },
    { value: "sat", label: t("shipping.day_sat") },
    { value: "sun", label: t("shipping.day_sun") },
  ];
}

// --- CSV Helpers ---

const VALID_SERVICE_CODES = new Set(["mox_envio", "mox_express", "mox_pickup"]);
const VALID_CONDITIONS = new Set(["all", "include", "exclude"]);
const VALID_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

// Orden y nombres de columnas del CSV — fuente única para header, export,
// parseo, plantilla y guía. Los 4 campos de precio (modo_precio, precio,
// rangos_peso, rangos_monto) van juntos + precio_item_adicional, para no
// confundir al merchant. El parseo es por NOMBRE de encabezado (no por
// posición), así reordenar aquí no rompe archivos exportados antes.
const CSV_COLUMNS = [
  { key: "department", es: "departamento", en: "department" },
  { key: "rate_name", es: "nombre_tarifa", en: "rate_name" },
  { key: "service_type", es: "tipo_servicio", en: "service_type" },
  { key: "pricing_mode", es: "modo_precio", en: "pricing_mode" },
  { key: "price", es: "precio", en: "price" },
  { key: "weight_ranges", es: "rangos_peso", en: "weight_ranges" },
  { key: "cart_ranges", es: "rangos_monto", en: "cart_ranges" },
  { key: "per_item_price", es: "precio_item_adicional", en: "per_item_price" },
  { key: "city_condition", es: "condicion_ciudad", en: "city_condition" },
  { key: "cities", es: "ciudades", en: "cities" },
  { key: "description", es: "descripcion", en: "description" },
  { key: "from_time", es: "hora_desde", en: "from_time" },
  { key: "to_time", es: "hora_hasta", en: "to_time" },
  { key: "days", es: "dias", en: "days" },
  { key: "product_condition", es: "condicion_producto", en: "product_condition" },
  { key: "product_tags", es: "tags_producto", en: "product_tags" },
  { key: "delivery_min_days", es: "entrega_min_dias", en: "delivery_min_days" },
  { key: "delivery_max_days", es: "entrega_max_dias", en: "delivery_max_days" },
  { key: "product_field", es: "campo_producto", en: "product_field" },
  { key: "product_match_mode", es: "modo_producto", en: "product_match_mode" },
  { key: "country", es: "pais", en: "country" },
  { key: "warehouse", es: "bodega", en: "warehouse" },
  { key: "city_aliases", es: "alias_ciudades", en: "city_aliases" },
  { key: "product_conditions", es: "condiciones_producto", en: "product_conditions" },
  { key: "product_condition_logic", es: "logica_condiciones_producto", en: "product_condition_logic" },
];

function getCSVHeaders(locale) {
  return CSV_COLUMNS.map((c) => (locale === "en" ? c.en : c.es)).join(",");
}

/** Parsea una línea CSV respetando campos entre comillas. Separador configurable
 * (`,` por defecto; Excel en español exporta con `;`). */
function parseCSVLine(line, delimiter = ",") {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Detecta el separador del CSV mirando el encabezado: Excel en locales es/eu
 * exporta con `;`. Cuenta separadores fuera de comillas y elige el dominante. */
function detectDelimiter(headerLine) {
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ",") commas++;
    else if (!inQuotes && ch === ";") semis++;
  }
  return semis > commas ? ";" : ",";
}

/** Parsea el contenido completo del CSV y retorna rows + errors. */
function parseCSVContent(csvText, t) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { rows: [], errors: [t("csv.min_rows")] };
  }

  // Excel (locales es/eu) exporta CSV con `;`; el nuestro usa `,`. Autodetecta
  // para que un archivo editado y guardado en Excel no descuadre las columnas.
  const delimiter = detectDelimiter(lines[0]);
  const firstLine = parseCSVLine(lines[0], delimiter).map((h) => h.toLowerCase().trim());
  // Reconoce el encabezado en ambos idiomas — el export puede venir de
  // cualquiera de los dos locales y debe poder re-importarse.
  const isHeader =
    firstLine.includes("departamento") ||
    firstLine.includes("nombre_tarifa") ||
    firstLine.includes("department") ||
    firstLine.includes("rate_name");
  const startIdx = isHeader ? 1 : 0;

  // Mapa key→posición. Con encabezado se resuelve por NOMBRE (es/en), así el
  // orden de las columnas puede cambiar sin romper archivos viejos. Sin
  // encabezado se cae al orden posicional canónico de CSV_COLUMNS.
  const colPos = {};
  CSV_COLUMNS.forEach((c, i) => {
    colPos[c.key] = i;
  });
  const headerPos = {};
  if (isHeader) {
    firstLine.forEach((h, pos) => {
      const col = CSV_COLUMNS.find((c) => c.es === h || c.en === h);
      if (col) headerPos[col.key] = pos;
    });
  }

  const rows = [];
  const errors = [];

  for (let i = startIdx; i < lines.length; i++) {
    const lineNum = i + 1;
    const fields = parseCSVLine(lines[i], delimiter);

    if (fields.length < 4) {
      errors.push(t("csv.missing_fields", { n: lineNum }));
      continue;
    }

    const get = (key) => {
      const pos = isHeader ? headerPos[key] : colPos[key];
      return pos != null && fields[pos] != null ? fields[pos] : "";
    };
    const dept = get("department");
    const name = get("rate_name");
    const serviceCode = get("service_type");
    const priceStr = get("price");
    const condition = get("city_condition");
    const citiesStr = get("cities");
    const description = get("description");
    const timeFrom = get("from_time");
    const timeTo = get("to_time");
    const daysStr = get("days");
    const pricingModeStr = get("pricing_mode");
    const weightTiersStr = get("weight_ranges");
    const cartTotalTiersStr = get("cart_ranges");
    const productConditionStr = get("product_condition");
    const productTagsStr = get("product_tags");
    const minDeliveryStr = get("delivery_min_days");
    const maxDeliveryStr = get("delivery_max_days");
    const productFieldStr = get("product_field");
    const productMatchModeStr = get("product_match_mode");
    const countryStr = get("country");
    const warehouseStr = get("warehouse");
    const cityAliasesStr = get("city_aliases");
    const perItemPriceStr = get("per_item_price");
    const productConditionsStr = get("product_conditions");
    const productConditionLogicStr = get("product_condition_logic");

    // Accept any non-empty region name. Membership in a fixed list can't be
    // enforced internationally (zones now span multiple countries); the zone
    // slug is derived from the name and matched the same way at checkout.
    if (!dept) {
      errors.push(t("csv.invalid_department", { n: lineNum, dept }));
      continue;
    }

    if (!name) {
      errors.push(t("csv.name_required", { n: lineNum }));
      continue;
    }

    if (!VALID_SERVICE_CODES.has(serviceCode)) {
      errors.push(t("csv.invalid_service", { n: lineNum, code: serviceCode }));
      continue;
    }

    const pricingMode = pricingModeStr === "weight_tiers" ? "weight_tiers"
      : pricingModeStr === "cart_total" ? "cart_total"
      : pricingModeStr === "per_item" ? "per_item" : "flat";

    // parseFloat (no parseInt): los precios pueden tener decimales (USD 12.99).
    const price = parseFloat(priceStr);
    if (pricingMode === "flat" && (isNaN(price) || price < 0)) {
      errors.push(t("csv.invalid_price", { n: lineNum, price: priceStr }));
      continue;
    }

    // Parsear weight tiers: formato "0-1:12000;1-5:18000;5-15:30000"
    let weightTiers = [];
    if (pricingMode === "weight_tiers" && weightTiersStr) {
      weightTiers = weightTiersStr.split(";").map((seg) => {
        const [range, tierPrice] = seg.split(":");
        const [minKg, maxKg] = range.split("-").map(Number);
        return { minKg: minKg || 0, maxKg: maxKg || 0, price: Number(tierPrice) || 0 };
      }).filter((t) => t.maxKg > t.minKg);
    }

    // Parsear cart total tiers: formato "0-100000:15000;100000-200000:10000;200000-500000:0"
    let cartTotalTiers = [];
    if (pricingMode === "cart_total" && cartTotalTiersStr) {
      cartTotalTiers = cartTotalTiersStr.split(";").map((seg) => {
        const [range, tierPrice] = seg.split(":");
        const [minAmount, maxAmount] = range.split("-").map(Number);
        return { minAmount: minAmount || 0, maxAmount: maxAmount || 0, price: Number(tierPrice) || 0 };
      }).filter((t) => t.maxAmount > t.minAmount);
    }

    const cityCondition = condition && VALID_CONDITIONS.has(condition) ? condition : "all";

    let cities = [];
    if (cityCondition !== "all" && citiesStr) {
      cities = citiesStr.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    }

    let days = [];
    if (daysStr) {
      days = daysStr.split(",").map((d) => d.trim().toLowerCase()).filter((d) => VALID_DAYS.has(d));
    }

    const VALID_PRODUCT_CONDITIONS = new Set(["all", "include", "exclude", "include_tags", "exclude_tags"]);
    const productCondition = productConditionStr && VALID_PRODUCT_CONDITIONS.has(productConditionStr)
      ? productConditionStr : "all";

    let productTags = [];
    if (productCondition !== "all" && productTagsStr) {
      productTags = productTagsStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    }

    const VALID_PRODUCT_FIELDS = new Set(["tags", "vendor", "product_type", "collection", "sku"]);
    const productField = productFieldStr && VALID_PRODUCT_FIELDS.has(productFieldStr) ? productFieldStr : "tags";
    const productMatchMode = productMatchModeStr === "all" ? "all" : "any";
    let productConditions = [];
    if (productConditionsStr) {
      try {
        const parsedConditions = JSON.parse(productConditionsStr);
        if (Array.isArray(parsedConditions)) {
          productConditions = parsedConditions;
        } else {
          errors.push(t("csv.invalid_product_conditions", { n: lineNum }));
          continue;
        }
      } catch {
        errors.push(t("csv.invalid_product_conditions", { n: lineNum }));
        continue;
      }
    }
    const productConditionLogic = productConditionLogicStr === "or" ? "or" : "and";

    // Alias de ciudad (opcional): "CANONICAL>alias1|alias2;CANONICAL2>alias3".
    // Mapa canónico→variantes para homologación fuzzy en checkout.
    const cityAliases = {};
    if (cityAliasesStr) {
      for (const seg of cityAliasesStr.split(";")) {
        const [canon, aliasesPart] = seg.split(">");
        const key = (canon || "").trim().toUpperCase();
        if (!key || !aliasesPart) continue;
        const arr = aliasesPart.split("|").map((a) => a.trim()).filter(Boolean);
        if (arr.length) cityAliases[key] = arr;
      }
    }

    rows.push({
      department: dept,
      name,
      serviceCode,
      price: isNaN(price) ? 0 : price,
      cityCondition,
      cities,
      cityAliases,
      // Nombre de bodega de origen (opcional) — se resuelve a warehouseId en el
      // import (necesita la lista de Locations / admin).
      warehouseName: (warehouseStr || "").trim(),
      // Modo per_item: precio por cada ítem adicional (opcional).
      perItemPrice: parseFloat(perItemPriceStr) || 0,
      description: description || "",
      timeFrom: timeFrom || null,
      timeTo: timeTo || null,
      daysOfWeek: days,
      pricingMode,
      weightTiers,
      cartTotalTiers,
      productCondition,
      productField,
      productMatchMode,
      productTags,
      productConditions,
      productConditionLogic,
      minDeliveryDays: minDeliveryStr || null,
      maxDeliveryDays: maxDeliveryStr || null,
      // ISO-2 opcional; vacío = país de la tienda (se resuelve en el import).
      country: /^[A-Za-z]{2}$/.test(countryStr || "") ? countryStr.toUpperCase() : null,
    });
  }

  return { rows, errors };
}

// --- Loader / Action ---

export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);

  // Each external dependency wrapped so a transient failure renders a degraded
  // page instead of a 500. Shopify App Review rejects on any uncaught 500.
  let zones = [];
  let defaultZones = [];
  let planInfo;
  // Shop currency / timezone / country — replaces the Colombia-only DEPARTMENTS
  // list, COP labels and es-CO number formatting. Never throws (falls back to
  // CO / COP for older rows).
  const shopMeta = await getShopMeta(session.shop);
  const subdivisions = isSupportedCountry(shopMeta.country)
    ? getSubdivisions(shopMeta.country).map((s) => s.name)
    : [];
  try {
    zones = await getZonesWithRates(session.shop);
  } catch (e) {
    logError("[shipping-rules loader] getZonesWithRates failed:", e?.message || e);
  }
  try {
    // Un default por país: siempre el del país de la tienda + uno por cada
    // país que ya tenga zonas creadas (multi-mercado).
    // Normalizar a ISO-2 mayúsculas para no duplicar un mercado por diferencias
    // de capitalización/espacios (ej. "CO" + "co" generaban dos defaults).
    const shopCountry = (shopMeta.country || "CO").trim().toUpperCase();
    const countrySet = new Set([shopCountry]);
    for (const z of zones) {
      if (z.country && !z.slug.startsWith("_default")) countrySet.add(z.country.trim().toUpperCase());
    }
    // Dedupe por slug: dos países distintos podrían resolver al mismo default
    // (_default del país de la tienda) y devolver la misma fila dos veces.
    const seenSlugs = new Set();
    for (const c of countrySet) {
      const dz = await getOrCreateDefaultZoneForCountry(session.shop, c, shopCountry);
      if (dz && !seenSlugs.has(dz.slug)) {
        seenSlugs.add(dz.slug);
        defaultZones.push(dz);
      }
    }
  } catch (e) {
    logError("[shipping-rules loader] getOrCreateDefaultZoneForCountry failed:", e?.message || e);
  }
  try {
    planInfo = await getShopPlan(billing, session.shop, admin);
  } catch (e) {
    logError("[shipping-rules loader] getShopPlan failed:", e?.message || e);
    planInfo = {
      plan: PLAN_FREE,
      limits: PLAN_LIMITS[PLAN_FREE],
      sponsored: false,
      subscription: null,
    };
  }
  // Pre-compute the Managed Pricing plan selection URL server-side so the
  // shipping-rules page can render a clear "Subscribe to use this feature"
  // banner with a native `<a target="_top">` link. Without this banner the
  // reviewer sees a page where nothing works and no explanation — a likely
  // rejection reason.
  const billingMode = getBillingMode();
  let planSelectionUrl = null;
  if (billingMode === "managed") {
    const appHandle = (process.env.APP_HANDLE || "").trim();
    const storeHandle = (session.shop || "").replace(/\.myshopify\.com$/, "");
    if (appHandle && storeHandle) {
      planSelectionUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
    }
  }

  // Países soportados + subdivisiones de cada uno para el selector de país
  // del formulario "Agregar zona" (multi-mercado).
  const countries = getCountries();
  const subdivisionsByCountry = {};
  // Versión {code,name} para el simulador de Consultar (provincia = código,
  // que el rate-engine resuelve a slug). El modal de tarifas usa solo nombres.
  const subdivisionsFull = {};
  for (const c of countries) {
    const subs = getSubdivisions(c.code);
    subdivisionsByCountry[c.code] = subs.map((s) => s.name);
    subdivisionsFull[c.code] = subs.map((s) => ({ code: s.code, name: s.name }));
  }

  // Países a los que la tienda realmente vende (Shopify Markets). El selector
  // de país solo ofrece estos — sin ruido de países donde no opera. Si la
  // query falla, null = mostrar todos los del dataset (fail open).
  let shipsToCountries = null;
  try {
    const res = await admin.graphql(`query { shop { shipsToCountries } }`);
    const data = await res.json();
    const list = data.data?.shop?.shipsToCountries;
    if (Array.isArray(list) && list.length > 0) shipsToCountries = list;
  } catch (e) {
    logError("[shipping-rules loader] shipsToCountries failed:", e?.message || e);
  }

  // Bodegas de origen (Shopify Locations) — solo para mostrar de qué bodega
  // sale cada tarifa. getWarehouses nunca lanza (devuelve [] ante error), así
  // que la página renderiza igual sin el tag de bodega si la API falla.
  const warehouses = await getWarehouses(admin);

  // Log de cotizaciones para la pestaña Consultar (paginación/filtro por query
  // params). Nunca rompe la página si falla.
  const url2 = new URL(request.url);
  const quotePage = parseInt(url2.searchParams.get("page") || "1", 10) || 1;
  const quoteOnlyEmpty = url2.searchParams.get("only_empty") === "1";
  const quoteSearch = url2.searchParams.get("q") || "";
  let quoteData = { total: 0, quotes: [], page: 1, pageSize: 25 };
  try {
    quoteData = await getQuotes(session.shop, { page: quotePage, onlyEmpty: quoteOnlyEmpty, search: quoteSearch });
  } catch (e) {
    logError("[shipping-rules loader] getQuotes failed:", e?.message || e);
  }

  return {
    quoteData,
    quoteOnlyEmpty,
    quoteSearch,
    retentionDays: QUOTE_RETENTION_DAYS,
    zones,
    defaultZones,
    planInfo,
    planSelectionUrl,
    billingMode,
    shopCountry: (shopMeta.country || "CO").trim().toUpperCase(),
    shopCurrency: shopMeta.currency,
    cityMatchThreshold: shopMeta.cityMatchThreshold,
    subdivisions,
    countries,
    subdivisionsByCountry,
    subdivisionsFull,
    shipsToCountries,
    warehouses,
  };
};

export const action = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const url = new URL(request.url);
  const locale = getLocale(url.searchParams.get("locale"));
  const t = createTranslator(locale);
  const planInfo = await getShopPlan(billing, session.shop, admin);
  const shopMeta = await getShopMeta(session.shop);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  try {
    if (intent === "simulate") {
      // Simulador de la pestaña Consultar — corre el MISMO pipeline del
      // checkout (rate-engine) sobre un destino + carrito ficticio.
      const destCountry = String(formData.get("country") || shopMeta.country || "CO");
      const province = String(formData.get("province") || "");
      const city = String(formData.get("city") || "");
      const weightKg = parseFloat(formData.get("weight_kg")) || 0;
      const cartTotal = parseFloat(formData.get("cart_total")) || 0;
      const itemTags = String(formData.get("tags") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const vendor = String(formData.get("vendor") || "").trim();
      const sku = String(formData.get("sku") || "").trim();
      const productType = String(formData.get("product_type") || "").trim();
      const collections = String(formData.get("collections") || "").split(",").map((s) => s.trim()).filter(Boolean);

      if (!province) return { error: t("quotes.sim_province_required") };

      const items = [{ name: t("quotes.sim_item_name"), quantity: 1, grams: Math.round(weightKg * 1000), price: Math.round(cartTotal * 100), properties: {} }];
      const cartProducts = [{ sku, vendor, productType, tags: itemTags, collections }];

      // Origen simulado (opcional): ejercita el scope por bodega igual que un
      // checkout real despachando desde esa Location. Vacío = sin filtro.
      const originWarehouseId = formData.get("origin_warehouse") || null;

      const trace = createQuoteTrace();
      const result = await quoteShipping({ shop: session.shop, destCountry, province, city, items, shopMeta, cartProducts, trace, originWarehouseId });
      const rates = result.finalRates.map((entry) => ({
        name: entry.rate ? entry.rate.name : entry.name,
        serviceCode: entry.rate ? entry.rate.serviceCode : entry.serviceCode,
        price: entry.price,
      }));
      void saveQuote({
        shop: session.shop, source: "simulator", country: destCountry, province, city,
        resolvedCity: result.resolvedCity, resolveMethod: result.cityResolution.method,
        departmentSlug: result.departmentSlug, items, cartWeightKg: result.cartWeightKg,
        cartTotal: result.cartTotal, currency: shopMeta.currency || "COP", trace,
        ratesReturned: rates.map((r) => ({ name: r.name, serviceCode: r.serviceCode, totalPrice: String(Math.round(r.price * 100)), currency: shopMeta.currency || "COP" })),
      });
      return {
        simulation: {
          rates, steps: trace.steps, decisions: trace.rules,
          departmentName: result.departmentName, departmentSlug: result.departmentSlug,
          resolvedCity: result.resolvedCity, resolveMethod: result.cityResolution.method,
          pickupMismatch: result.pickupMismatchDept || null,
        },
      };
    }

    if (intent === "create_zone") {
      const department = formData.get("department");
      if (!department) return { error: t("action.select_department") };

      // País de la zona (multi-mercado). Cualquier ISO-2 válido se acepta —
      // el dataset solo gatea el catálogo de subdivisiones, no la validez del
      // país (la tienda puede vender a países sin catálogo, con región libre).
      const rawCountry = String(formData.get("country") || "").toUpperCase();
      const zoneCountry = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : (shopMeta.country || "CO");

      const currentZoneCount = await prisma.shippingZone.count({ where: { shop: session.shop } });
      if (!checkLimit(planInfo, "zones", currentZoneCount)) {
        return { error: t("billing.limit_zones", { max: planInfo.limits.maxZones }) };
      }

      // Auto-detect which services make sense for this department based on the
      // merchant's Shopify Locations. Falls back to all services on any failure.
      const enabledServices = await detectEnabledServicesForDepartment(admin, department);

      await createZone(session.shop, department, enabledServices, zoneCountry);
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.zone_created", { dept: department }) };
    }

    if (intent === "update_zone_services") {
      const zoneId = formData.get("zoneId");
      const services = formData.getAll("enabledServices").filter((s) =>
        VALID_SERVICE_CODES.has(s),
      );
      if (services.length === 0) {
        return { error: t("action.zone_services_empty") };
      }
      await updateZoneEnabledServices(session.shop, zoneId, services);
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.zone_services_updated") };
    }

    if (intent === "duplicate_zone") {
      // Duplicar zona hacia otro departamento (copia todas las tarifas).
      const sourceZoneId = formData.get("zoneId");
      const targetDepartment = String(formData.get("target_department") || "").trim();
      if (!targetDepartment) return { error: t("action.select_department") };

      // Límites del plan: zona nueva (si no existe) + tarifas resultantes.
      const source = await prisma.shippingZone.findFirst({
        where: { id: sourceZoneId, shop: session.shop },
        include: { rates: { select: { id: true } } },
      });
      if (!source) return { error: t("action.unexpected_error") };
      const targetSlug = zoneSlugForCountry(source.country || "CO", targetDepartment);
      const existingTarget = await prisma.shippingZone.findUnique({
        where: { shop_slug: { shop: session.shop, slug: targetSlug } },
        include: { rates: { select: { id: true } } },
      });
      if (!existingTarget) {
        const zonesCount = await prisma.shippingZone.count({ where: { shop: session.shop } });
        if (!checkLimit(planInfo, "zones", zonesCount)) {
          return { error: t("billing.limit_zones", { max: planInfo.limits.maxZones }) };
        }
      }
      const resultingRates = (existingTarget?.rates.length || 0) + source.rates.length;
      if (resultingRates > planInfo.limits.maxRatesPerZone) {
        return { error: t("billing.limit_rates", { max: planInfo.limits.maxRatesPerZone }) };
      }

      const dup = await duplicateZoneTo(session.shop, sourceZoneId, targetDepartment);
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.zone_duplicated", { dept: targetDepartment, n: dup.ratesCopied }) };
    }

    if (intent === "delete_zone") {
      const zoneId = formData.get("zoneId");
      await deleteZone(zoneId, session.shop);
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.zone_deleted") };
    }

    if (intent === "update_threshold") {
      const raw = parseInt(formData.get("cityMatchThreshold"), 10);
      // Clamp 50-100. Below 50 fuzzy matching is too loose to be safe.
      const value = Number.isNaN(raw) ? 85 : Math.min(100, Math.max(50, raw));
      await prisma.appShop.upsert({
        where: { shop: session.shop },
        create: { shop: session.shop, cityMatchThreshold: value },
        update: { cityMatchThreshold: value },
      });
      return { success: true, message: t("action.threshold_updated", { value }) };
    }

    if (intent === "save_rate") {
      const allData = Object.fromEntries(formData.entries());
      debug("[shipping-rules] save_rate form data:", JSON.stringify(allData, null, 2));

      const rateId = formData.get("rateId") || undefined;
      // Edición → zoneId (la zona no cambia). Alta desde el modal → uno o
      // varios `department` (nombres) + `country`: la zona se crea al vuelo si
      // no existe, para poder agregar tarifas a cualquier departamento.
      const zoneId = formData.get("zoneId");
      const createCountry = (formData.get("country") || shopMeta.country || "CO").toUpperCase();
      const createDepartments = formData.getAll("department").filter(Boolean);
      const pricingMode = formData.get("pricingMode") || "flat";
      const timeFrom = formData.get("timeFrom") || null;
      const timeTo = formData.get("timeTo") || null;
      const daysRaw = formData.getAll("daysOfWeek");

      if (pricingMode === "weight_tiers" && !checkLimit(planInfo, "weightTiers", 0)) {
        return { error: t("billing.limit_feature") };
      }
      if (pricingMode === "cart_total" && !checkLimit(planInfo, "cartTotalTiers", 0)) {
        return { error: t("billing.limit_feature") };
      }
      if ((timeFrom || timeTo || daysRaw.length > 0) && !checkLimit(planInfo, "schedule", 0)) {
        return { error: t("billing.limit_feature") };
      }

      const productCondition = formData.get("productCondition") || "all";
      if (productCondition !== "all" && !checkLimit(planInfo, "productTags", 0)) {
        return { error: t("billing.limit_feature") };
      }

      const cityCondition = formData.get("cityCondition") || "all";
      const citiesInput = formData.get("cities_input") || "";

      let citiesJson = "[]";
      if (cityCondition !== "all" && citiesInput.trim()) {
        const citiesArray = citiesInput
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
        citiesJson = JSON.stringify(citiesArray);
      }

      // Per-city aliases for fuzzy homologation. Keys uppercased to match the
      // canonical cities stored above; values trimmed, empties dropped.
      let cityAliasesJson = "{}";
      if (cityCondition !== "all") {
        try {
          const raw = JSON.parse(formData.get("city_aliases_input") || "{}");
          const norm = {};
          for (const [k, v] of Object.entries(raw)) {
            const key = String(k).trim().toUpperCase();
            const arr = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
            if (key && arr.length) norm[key] = arr;
          }
          cityAliasesJson = JSON.stringify(norm);
        } catch {
          // Malformed alias payload — persist empty map rather than fail save.
        }
      }

      const daysJson = daysRaw.length > 0 ? JSON.stringify(daysRaw) : "[]";

      // Campos comunes de la tarifa. zoneId es lo único que varía cuando la
      // misma tarifa se crea en varios departamentos (modal nueva tarifa).
      const rateData = {
        shop: session.shop,
        name: formData.get("name"),
        serviceCode: formData.get("serviceCode"),
        price: formData.get("price"),
        description: formData.get("description"),
        cityCondition,
        cities: citiesJson,
        cityAliases: cityAliasesJson,
        timeFrom,
        timeTo,
        daysOfWeek: daysJson,
        pricingMode,
        weightTiers: formData.get("weightTiers") || "[]",
        cartTotalTiers: formData.get("cartTotalTiers") || "[]",
        productCondition,
        productField: formData.get("productField") || "tags",
        productMatchMode: formData.get("productMatchMode") || "any",
        productTags: formData.get("productTags") || "[]",
        productConditions: formData.get("productConditions") || "[]",
        productConditionLogic: formData.get("productConditionLogic") || "and",
        minDeliveryDays: formData.get("minDeliveryDays"),
        maxDeliveryDays: formData.get("maxDeliveryDays"),
        warehouseId: formData.get("warehouseId") || null,
        perItemPrice: formData.get("perItemPrice") || 0,
      };

      if (rateId) {
        // Edición: una sola tarifa (zoneId no cambia en saveRate al editar).
        await saveRate({ id: rateId, zoneId, ...rateData });
      } else if (createDepartments.length === 0 && zoneId) {
        // Alta en una zona conocida (ej. tarifa por defecto / zona _default):
        // no hay departamento del catálogo, se crea directo en ese zoneId.
        const rateCount = await prisma.shippingRate.count({ where: { zoneId } });
        if (!checkLimit(planInfo, "ratesPerZone", rateCount)) {
          return { error: t("billing.limit_rates", { max: planInfo.limits.maxRatesPerZone }) };
        }
        await saveRate({ zoneId, ...rateData });
      } else {
        // Alta: una tarifa por departamento elegido. Crea la zona si no existe
        // (get-or-create por slug), respetando los límites del plan.
        let zonesCount = await prisma.shippingZone.count({ where: { shop: session.shop } });
        for (const dept of createDepartments) {
          const slug = zoneSlugForCountry(createCountry, dept);
          let zone = await prisma.shippingZone.findUnique({
            where: { shop_slug: { shop: session.shop, slug } },
          });
          if (!zone) {
            if (!checkLimit(planInfo, "zones", zonesCount)) {
              return { error: t("billing.limit_zones", { max: planInfo.limits.maxZones }) };
            }
            const enabledServices = await detectEnabledServicesForDepartment(admin, dept);
            zone = await createZone(session.shop, dept, enabledServices, createCountry);
            zonesCount++;
          }
          const rateCount = await prisma.shippingRate.count({ where: { zoneId: zone.id } });
          if (!checkLimit(planInfo, "ratesPerZone", rateCount)) {
            return { error: t("billing.limit_rates", { max: planInfo.limits.maxRatesPerZone }) };
          }
          await saveRate({ zoneId: zone.id, ...rateData });
        }
      }
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.rate_saved") };
    }

    if (intent === "toggle_rate") {
      // Habilitar/deshabilitar tarifa sin borrarla. Checkout y metafield ya
      // excluyen las deshabilitadas (enabled: false) — solo cambia el flag.
      const rateId = formData.get("rateId");
      const enabled = formData.get("enabled") === "true";
      const existing = await prisma.shippingRate.findFirst({
        where: { id: rateId, zone: { shop: session.shop } },
      });
      if (!existing) return { error: t("action.unexpected_error") };
      await prisma.shippingRate.update({ where: { id: rateId }, data: { enabled } });
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: enabled ? t("action.rate_enabled") : t("action.rate_disabled") };
    }

    if (intent === "delete_rate") {
      const rateId = formData.get("rateId");
      await deleteRate(rateId, session.shop);
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.rate_deleted") };
    }

    if (intent === "duplicate_rate") {
      const rateId = formData.get("rateId");
      const zoneId = formData.get("zoneId");
      const currentRateCount = await prisma.shippingRate.count({ where: { zoneId } });
      if (!checkLimit(planInfo, "ratesPerZone", currentRateCount)) {
        return { error: t("billing.limit_rates", { max: planInfo.limits.maxRatesPerZone }) };
      }
      await duplicateRate(rateId, session.shop, t("shipping.copy_suffix"));
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.rate_duplicated") };
    }

    if (intent === "sync_metafield") {
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.synced") };
    }

    if (intent === "register_carrier") {
      const result = await ensureFletixCarrierService(admin, session.shop);
      if (result.errors?.length) {
        return { error: result.errors.join(", ") };
      }
      const message =
        result.status === "created"
          ? t("action.carrier_registered")
          : t("action.carrier_updated");
      return { success: true, message };
    }

    if (intent === "upload_csv") {
      if (!checkLimit(planInfo, "csv", 0)) {
        return { error: t("billing.limit_feature") };
      }
      const csvContent = formData.get("csv_content");
      if (!csvContent || !csvContent.trim()) return { error: t("action.unexpected_error") };

      const { rows, errors: parseErrors } = parseCSVContent(csvContent, t);

      if (rows.length === 0) {
        return { error: `No se encontraron filas válidas.${parseErrors.length ? " " + parseErrors.join("; ") : ""}` };
      }

      // Mapa de zonas existentes por país+departamento (multi-mercado: el
      // mismo nombre de subdivisión puede existir en dos países).
      const existingZones = await getZonesWithRates(session.shop);
      const zoneByDept = {};
      for (const z of existingZones) {
        zoneByDept[`${z.country || "CO"}|${z.department}`] = z;
      }

      // Pre-fetch Locations once for the whole import so each new zone gets
      // its enabledServices auto-detected without N extra GraphQL calls.
      const locationsMap = await getServiceAvailabilityByProvince(admin);

      // Bodegas para resolver la columna `bodega` (nombre → warehouseId).
      // Match por nombre normalizado; sin match → null (= todas las bodegas).
      const csvWarehouses = await getWarehouses(admin);
      const normName = (s) => String(s || "").trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const warehouseByName = new Map(csvWarehouses.map((w) => [normName(w.name), w.id]));

      let zonesCreated = 0;
      let ratesCreated = 0;

      for (const row of rows) {
        const rowCountry = row.country || shopMeta.country || "CO";
        const zoneKey = `${rowCountry}|${row.department}`;
        if (!zoneByDept[zoneKey]) {
          const slug = row.department
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
          const enabledServices = locationsMap[slug] ?? locationsMap.default ?? [
            "mox_envio", "mox_express", "mox_pickup",
          ];
          const newZone = await createZone(session.shop, row.department, enabledServices, rowCountry);
          zoneByDept[zoneKey] = newZone;
          zonesCreated++;
        }

        await saveRate({
          zoneId: zoneByDept[zoneKey].id,
          shop: session.shop,
          name: row.name,
          serviceCode: row.serviceCode,
          price: row.price,
          description: row.description,
          cityCondition: row.cityCondition,
          cities: JSON.stringify(row.cities),
          cityAliases: JSON.stringify(row.cityAliases || {}),
          warehouseId: row.warehouseName ? (warehouseByName.get(normName(row.warehouseName)) || null) : null,
          perItemPrice: row.perItemPrice,
          timeFrom: row.timeFrom,
          timeTo: row.timeTo,
          daysOfWeek: JSON.stringify(row.daysOfWeek),
          pricingMode: row.pricingMode,
          weightTiers: JSON.stringify(row.weightTiers),
          cartTotalTiers: JSON.stringify(row.cartTotalTiers),
          productCondition: row.productCondition,
          productField: row.productField,
          productMatchMode: row.productMatchMode,
          productTags: JSON.stringify(row.productTags),
          productConditions: JSON.stringify(row.productConditions || []),
          productConditionLogic: row.productConditionLogic || "and",
          minDeliveryDays: row.minDeliveryDays,
          maxDeliveryDays: row.maxDeliveryDays,
        });
        ratesCreated++;
      }

      await syncRulesToMetafield(admin, session.shop);

      return {
        success: true,
        message: t("csv.import_success", { zones: zonesCreated, rates: ratesCreated }),
        importResults: { zonesCreated, ratesCreated, errors: parseErrors },
      };
    }

    return { error: t("action.unexpected_error") };
  } catch (err) {
    logError(`[shipping-rules] Error (${intent}):`, err);
    return { error: err?.message || t("action.unexpected_error") };
  }
};

// --- Components ---

function CityPicker({ department, selectedCities, onChange, aliases = {}, onAliasesChange }) {
  // The municipality catalog is Colombia-only. For zones in other countries it
  // is empty, so fall back to free-text entry (merchant types the city name,
  // normalized the same way at checkout).
  const municipalities = MUNICIPALITIES[department] || [];
  const hasCatalog = municipalities.length > 0;

  const addCity = (val) => {
    const city = (val || "").trim();
    if (!city || selectedCities.some((c) => c.toUpperCase() === city.toUpperCase())) return;
    onChange([...selectedCities, city]);
  };

  const handleAdd = (e) => {
    addCity(e.target.value);
    e.target.value = "";
  };

  const handleRemove = (city) => {
    onChange(selectedCities.filter((c) => c !== city));
    // Drop the removed city's aliases so the stored map stays clean.
    if (onAliasesChange && aliases[city]) {
      const next = { ...aliases };
      delete next[city];
      onAliasesChange(next);
    }
  };

  // Aliases edited as a comma-separated string per city ("medallo, medeya").
  const handleAliasChange = (city, raw) => {
    if (!onAliasesChange) return;
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const next = { ...aliases };
    if (list.length) next[city] = list;
    else delete next[city];
    onAliasesChange(next);
  };

  return (
    <div>
      <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
        Ciudades
      </label>
      {hasCatalog ? (
        <select
          onChange={handleAdd}
          defaultValue=""
          style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "250px", marginBottom: "8px" }}
        >
          <option value="">Agregar ciudad...</option>
          {municipalities
            .filter((m) => !selectedCities.includes(m))
            .map((m) => (
              <option key={m} value={m}>{titleCase(m)}</option>
            ))}
        </select>
      ) : (
        <input
          type="text"
          placeholder="Escribir ciudad y Enter..."
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCity(e.target.value);
              e.target.value = "";
            }
          }}
          onBlur={(e) => { addCity(e.target.value); e.target.value = ""; }}
          style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "250px", marginBottom: "8px" }}
        />
      )}
      {selectedCities.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" }}>
          {selectedCities.map((city) => (
            <div key={city} style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  padding: "4px 10px", borderRadius: "999px",
                  background: "#e5e5e5", fontSize: "12px", fontWeight: 600,
                  minWidth: "110px", justifyContent: "space-between",
                }}
              >
                {titleCase(city)}
                <button
                  type="button"
                  onClick={() => handleRemove(city)}
                  style={{
                    border: "none", background: "none", cursor: "pointer",
                    fontSize: "14px", lineHeight: 1, padding: 0, color: "#666",
                  }}
                >
                  ×
                </button>
              </span>
              {/* Variantes/apodos: el comprador puede escribir cualquiera y se
                  homologa por fuzzy a esta ciudad en checkout. */}
              <input
                type="text"
                defaultValue={(aliases[city] || []).join(", ")}
                onBlur={(e) => handleAliasChange(city, e.target.value)}
                placeholder="variantes: medallo, medeya…"
                style={{ flex: 1, minWidth: "200px", padding: "6px 10px", borderRadius: "8px", border: "1px solid #ddd", fontSize: "12px" }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function titleCase(str) {
  return str.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function WeightTierEditor({ tiers, onChange, t }) {
  const currency = useShopCurrency();
  const handleTierChange = (index, field, value) => {
    const updated = [...tiers];
    updated[index] = { ...updated[index], [field]: Number(value) || 0 };
    // Auto-encadenar: el min del siguiente tier = max del actual
    if (field === "maxKg" && index < updated.length - 1) {
      updated[index + 1] = { ...updated[index + 1], minKg: updated[index].maxKg };
    }
    onChange(updated);
  };

  const addTier = () => {
    const lastMax = tiers.length > 0 ? tiers[tiers.length - 1].maxKg : 0;
    onChange([...tiers, { minKg: lastMax, maxKg: lastMax + 5, price: 0 }]);
  };

  const removeTier = (index) => {
    const updated = tiers.filter((_, i) => i !== index);
    // Re-encadenar mins
    for (let i = 1; i < updated.length; i++) {
      updated[i] = { ...updated[i], minKg: updated[i - 1].maxKg };
    }
    onChange(updated);
  };

  return (
    <div>
      <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>
        {t("shipping.weight_ranges")}
      </label>
      {tiers.map((tier, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px",
        }}>
          <input
            type="number"
            value={tier.minKg}
            onChange={(e) => handleTierChange(i, "minKg", e.target.value)}
            style={{ width: "70px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", textAlign: "right" }}
            min="0"
            step="0.1"
            readOnly={i > 0}
          />
          <span style={{ fontSize: "12px", color: "#666" }}>kg →</span>
          <input
            type="number"
            value={tier.maxKg}
            onChange={(e) => handleTierChange(i, "maxKg", e.target.value)}
            style={{ width: "70px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", textAlign: "right" }}
            min={tier.minKg}
            step="0.1"
          />
          <span style={{ fontSize: "12px", color: "#666" }}>kg</span>
          <span style={{ fontSize: "12px", color: "#666", marginLeft: "8px" }}>$</span>
          <input
            type="number"
            value={tier.price}
            onChange={(e) => handleTierChange(i, "price", e.target.value)}
            style={{ width: "110px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", textAlign: "right" }}
            min="0"
            step="any"
          />
          <span style={{ fontSize: "12px", color: "#666" }}>{currency}</span>
          <button
            type="button"
            onClick={() => removeTier(i)}
            style={{
              border: "none", background: "none", cursor: "pointer",
              fontSize: "16px", color: "#c00", padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addTier}
        style={{
          padding: "6px 14px", borderRadius: "8px", border: "1px dashed #999",
          background: "none", cursor: "pointer", fontSize: "13px", color: "#333",
        }}
      >
        {t("shipping.add_range")}
      </button>
    </div>
  );
}

function CartTotalTierEditor({ tiers, onChange, t }) {
  const handleTierChange = (index, field, value) => {
    const updated = [...tiers];
    updated[index] = { ...updated[index], [field]: Number(value) || 0 };
    // Auto-encadenar: el min del siguiente tier = max del actual
    if (field === "maxAmount" && index < updated.length - 1) {
      updated[index + 1] = { ...updated[index + 1], minAmount: updated[index].maxAmount };
    }
    onChange(updated);
  };

  const toggleNoLimit = (index, checked) => {
    const updated = [...tiers];
    updated[index] = { ...updated[index], maxAmount: checked ? 0 : updated[index].minAmount + 100000 };
    onChange(updated);
  };

  const addTier = () => {
    const lastTier = tiers.length > 0 ? tiers[tiers.length - 1] : null;
    // Si el último tier es "sin límite", darle un techo antes de agregar uno nuevo
    if (lastTier && lastTier.maxAmount === 0) {
      const updated = [...tiers];
      updated[updated.length - 1] = { ...lastTier, maxAmount: lastTier.minAmount + 100000 };
      onChange([...updated, { minAmount: lastTier.minAmount + 100000, maxAmount: 0, price: 0 }]);
      return;
    }
    const lastMax = lastTier ? lastTier.maxAmount : 0;
    onChange([...tiers, { minAmount: lastMax, maxAmount: 0, price: 0 }]);
  };

  const removeTier = (index) => {
    const updated = tiers.filter((_, i) => i !== index);
    for (let i = 1; i < updated.length; i++) {
      updated[i] = { ...updated[i], minAmount: updated[i - 1].maxAmount || updated[i].minAmount };
    }
    onChange(updated);
  };

  return (
    <div>
      <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>
        {t("shipping.cart_total_ranges")}
      </label>
      {tiers.map((tier, i) => {
        const isNoLimit = tier.maxAmount === 0;
        const isLast = i === tiers.length - 1;
        return (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap",
        }}>
          <span style={{ fontSize: "12px", color: "#666" }}>$</span>
          <input
            type="number"
            value={tier.minAmount}
            onChange={(e) => handleTierChange(i, "minAmount", e.target.value)}
            style={{ width: "110px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", textAlign: "right" }}
            min="0"
            readOnly={i > 0}
          />
          {isNoLimit ? (
            <span style={{ fontSize: "12px", color: "#16a34a", fontWeight: 600, minWidth: "120px" }}>{t("shipping.onwards")}</span>
          ) : (
            <>
              <span style={{ fontSize: "12px", color: "#666" }}>→ $</span>
              <input
                type="number"
                value={tier.maxAmount}
                onChange={(e) => handleTierChange(i, "maxAmount", e.target.value)}
                style={{ width: "110px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", textAlign: "right" }}
                min={tier.minAmount}
              />
            </>
          )}
          <span style={{ fontSize: "12px", color: "#666", marginLeft: "8px" }}>{t("shipping.shipping_label")}</span>
          <input
            type="number"
            value={tier.price}
            onChange={(e) => handleTierChange(i, "price", e.target.value)}
            style={{ width: "110px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", textAlign: "right" }}
            min="0"
          />
          {isLast && (
            <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#666", cursor: "pointer", marginLeft: "4px" }}>
              <input type="checkbox" checked={isNoLimit} onChange={(e) => toggleNoLimit(i, e.target.checked)} />
              {t("shipping.no_limit")}
            </label>
          )}
          <button
            type="button"
            onClick={() => removeTier(i)}
            style={{
              border: "none", background: "none", cursor: "pointer",
              fontSize: "16px", color: "#c00", padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>
        );
      })}
      <button
        type="button"
        onClick={addTier}
        style={{
          padding: "6px 14px", borderRadius: "8px", border: "1px dashed #999",
          background: "none", cursor: "pointer", fontSize: "13px", color: "#333",
        }}
      >
        {t("shipping.add_range")}
      </button>
    </div>
  );
}

function ProductTagInput({ tags, onChange, placeholder }) {
  const [inputValue, setInputValue] = useState("");

  // Convierte el texto pendiente en chips. Soporta pegar varios valores
  // separados por coma. Se invoca en Enter/coma Y en blur — sin el blur, el
  // merchant que escribe y va directo a "Guardar" perdía el valor silencioso.
  const commitInput = () => {
    if (!inputValue.trim()) return;
    const newTags = inputValue
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !tags.includes(s));
    if (newTags.length) onChange([...tags, ...newTags]);
    setInputValue("");
  };

  const handleKeyDown = (e) => {
    if ((e.key === "Enter" || e.key === ",") && inputValue.trim()) {
      e.preventDefault();
      commitInput();
    }
    if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  const removeTag = (tagToRemove) => {
    onChange(tags.filter((t) => t !== tagToRemove));
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "6px" }}>
        {tags.map((tag) => (
          <span
            key={tag}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              padding: "3px 10px", borderRadius: "999px",
              background: "#dbeafe", border: "1px solid #93c5fd",
              fontSize: "12px", fontWeight: 600, color: "#1e40af",
            }}
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              style={{
                border: "none", background: "none", cursor: "pointer",
                fontSize: "14px", lineHeight: 1, padding: 0, color: "#3b82f6",
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitInput}
        placeholder={placeholder}
        style={{
          padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc",
          width: "100%", maxWidth: "350px", fontSize: "13px",
        }}
      />
    </div>
  );
}

function ProFeatureNotice({ t }) {
  return (
    <s-text variant="bodySm" tone="subdued">
      {t("shipping.pro_feature_notice")}{" "}
      <s-link href="/app/billing">{t("shipping.pro_feature_link")}</s-link>
    </s-text>
  );
}

function getInitialProductConditions(rate) {
  const fallbackJoin = rate?.productConditionLogic === "or" ? "or" : "and";
  try {
    const parsed = JSON.parse(rate?.productConditions || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((condition, index) => ({
        field: condition.field || "tags",
        matchMode: condition.matchMode === "all" ? "all" : "any",
        values: Array.isArray(condition.values) ? condition.values : [],
        join: index === 0
          ? "and"
          : (condition.join === "or" || condition.join === "and" ? condition.join : fallbackJoin),
      }));
    }
  } catch {
    // JSON viejo o inválido: usar los campos legacy de abajo.
  }

  let values = [];
  try {
    values = rate?.productTags ? JSON.parse(rate.productTags) : [];
  } catch {
    values = [];
  }
  return [{
    field: rate?.productField || "tags",
    matchMode: rate?.productMatchMode === "all" ? "all" : "any",
    values: Array.isArray(values) ? values : [],
    join: "and",
  }];
}

function RateForm({ rate, zoneId, zoneSlug, createCountry, createDepartments, department, onCancel, t, planLimits, enabledServices }) {
  // Alta desde el modal: se reciben nombres de departamento (+ país); la zona
  // se crea al vuelo en el server. Edición: zoneId fijo.
  const createNames = Array.isArray(createDepartments) ? createDepartments.filter(Boolean) : [];
  const isCreate = !rate?.id;
  const allowedServices = Array.isArray(enabledServices) && enabledServices.length > 0
    ? enabledServices
    : ["mox_envio", "mox_express", "mox_pickup"];
  const availableServiceCodes = getServiceCodes(t).filter((sc) =>
    allowedServices.includes(sc.value),
  );
  const fallbackService = availableServiceCodes[0]?.value || "mox_envio";
  const currency = useShopCurrency();
  const fetcher = useFetcher();
  const [cityCondition, setCityCondition] = useState(rate?.cityCondition || "all");
  const [selectedCities, setSelectedCities] = useState(
    rate?.cities ? JSON.parse(rate.cities) : []
  );
  // Map canonical city -> array of merchant-defined aliases for fuzzy homologation.
  const [cityAliases, setCityAliases] = useState(() => {
    try {
      return rate?.cityAliases ? JSON.parse(rate.cityAliases) : {};
    } catch {
      return {};
    }
  });
  const [pricingMode, setPricingMode] = useState(rate?.pricingMode || "flat");
  // Normaliza valores legacy (include_tags/exclude_tags) al modelo nuevo.
  const initialCondition = rate?.productCondition === "include_tags" ? "include"
    : rate?.productCondition === "exclude_tags" ? "exclude"
    : rate?.productCondition || "all";
  const [productCondition, setProductCondition] = useState(initialCondition);
  const [productConditions, setProductConditions] = useState(() => getInitialProductConditions(rate));
  const productConditionLogic = productConditions.length > 1
    && productConditions.slice(1).every((condition) => condition.join === "or")
    ? "or"
    : "and";
  const [weightTiers, setWeightTiers] = useState(
    rate?.weightTiers ? JSON.parse(rate.weightTiers) : []
  );
  const [cartTotalTiers, setCartTotalTiers] = useState(
    rate?.cartTotalTiers ? JSON.parse(rate.cartTotalTiers) : []
  );

  const wasSubmittingRef = useRef(false);
  useEffect(() => {
    if (fetcher.state === "submitting" || fetcher.state === "loading") {
      wasSubmittingRef.current = true;
      return;
    }
    if (fetcher.state !== "idle" || !wasSubmittingRef.current) return;

    wasSubmittingRef.current = false;
    if (fetcher.data?.success && onCancel) onCancel();
  }, [fetcher.state, fetcher.data, onCancel]);

  const isEditing = !!rate?.id;
  const isSaving = fetcher.state !== "idle";

  const allowWeight = planLimits.weightTiers === true;
  const allowCart = planLimits.cartTotalTiers === true;
  const allowSchedule = planLimits.scheduleRestrictions === true;
  const allowProductTags = planLimits.productTagRates === true;

  const planBlocksSave = useMemo(() => {
    if (!rate?.id) return false;
    const days = JSON.parse(rate.daysOfWeek || "[]");
    if (!allowWeight && rate.pricingMode === "weight_tiers") return true;
    if (!allowCart && rate.pricingMode === "cart_total") return true;
    if (!allowProductTags && rate.productCondition && rate.productCondition !== "all") return true;
    if (!allowSchedule && (rate.timeFrom || rate.timeTo || days.length > 0)) return true;
    return false;
  }, [rate, allowWeight, allowCart, allowSchedule, allowProductTags]);

  // Preview en vivo de la bodega de origen por departamento. Se recalcula al
  // cambiar la condición de ciudad o las ciudades seleccionadas (ciudad →
  // depto como fallback). Display only — no afecta checkout ni routing.
  const warehouses = useWarehouses();
  const originPreview = useMemo(() => {
    if (!warehouses.length) return null;
    // Zonas objetivo: en alta, los departamentos elegidos (slug por país); en
    // edición, la zona de la tarifa.
    const targets = isCreate
      ? createNames.map((name) => ({ department: name, slug: zoneSlugForCountry(createCountry || "CO", name) }))
      : (zoneSlug ? [{ department, slug: zoneSlug }] : []);
    if (!targets.length) return null;
    const citiesJson = JSON.stringify(selectedCities);
    return targets.map((z) => {
      const cand = warehousesForRate({ cityCondition, cities: citiesJson }, z.slug, warehouses);
      return {
        dept: z.department,
        label: cand.length === 1 ? cand[0].name : t("shipping.origin_any"),
      };
    });
  }, [isCreate, createNames, createCountry, zoneSlug, department, warehouses, cityCondition, selectedCities, t]);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="_intent" value="save_rate" />
      {rate?.id ? (
        <>
          <input type="hidden" name="zoneId" value={zoneId} />
          <input type="hidden" name="rateId" value={rate.id} />
        </>
      ) : createNames.length ? (
        <>
          <input type="hidden" name="country" value={createCountry || "CO"} />
          {createNames.map((name) => (
            <input key={name} type="hidden" name="department" value={name} />
          ))}
        </>
      ) : (
        // Alta en zona conocida (tarifa por defecto): se manda el zoneId.
        <input type="hidden" name="zoneId" value={zoneId} />
      )}
      <input type="hidden" name="pricingMode" value={pricingMode} />
      <input type="hidden" name="weightTiers" value={JSON.stringify(weightTiers)} />
      <input type="hidden" name="cartTotalTiers" value={JSON.stringify(cartTotalTiers)} />
      <input type="hidden" name="productCondition" value={productCondition} />
      <input type="hidden" name="productConditionLogic" value={productConditionLogic} />
      <input type="hidden" name="productConditions" value={JSON.stringify(productConditions)} />
      <input type="hidden" name="productField" value={productConditions[0]?.field || "tags"} />
      <input type="hidden" name="productMatchMode" value={productConditions[0]?.matchMode || "any"} />
      <input type="hidden" name="productTags" value={JSON.stringify(productConditions[0]?.values || [])} />

      <s-stack direction="block" gap="base">
        {planBlocksSave && (
          <div style={{
            padding: "12px 14px",
            borderRadius: "10px",
            background: "#fff4e5",
            border: "1px solid #ffc078",
            fontSize: "13px",
            color: "#5c3b00",
          }}>
            {t("shipping.rate_locked_pro")}
          </div>
        )}
        <s-stack direction="inline" gap="base">
          <s-text-field
            label={t("shipping.name")}
            name="name"
            value={rate?.name || ""}
            required
            style={{ flex: 1 }}
          />
          <div>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
              {t("shipping.service_type")}
            </label>
            <select
              name="serviceCode"
              defaultValue={rate?.serviceCode && allowedServices.includes(rate.serviceCode) ? rate.serviceCode : fallbackService}
              style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "160px" }}
            >
              {availableServiceCodes.map((sc) => (
                <option key={sc.value} value={sc.value}>{sc.label}</option>
              ))}
            </select>
          </div>
          {pricingMode === "flat" && (
            <s-text-field
              label={t("shipping.price_cop", { currency })}
              name="price"
              type="number"
              step="any"
              min="0"
              value={String(rate?.price || "")}
              required
              style={{ maxWidth: "140px" }}
            />
          )}
          {(pricingMode === "weight_tiers" || pricingMode === "cart_total") && (
            <input type="hidden" name="price" value="0" />
          )}
        </s-stack>

        {/* Con 1 sola bodega el scope por origen es un no-op → no mostrar. */}
        {warehouses.length > 1 && (
          <div>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
              {t("shipping.origin_warehouse")}
            </label>
            <select
              name="warehouseId"
              defaultValue={rate?.warehouseId || ""}
              style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "260px" }}
            >
              <option value="">{t("shipping.origin_all")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}{w.city ? ` — ${w.city}` : ""}</option>
              ))}
            </select>
            <div style={{ marginTop: 4 }}>
              <s-text variant="bodySm" tone="subdued">
                {originPreview && originPreview.length === 1 && originPreview[0].label !== t("shipping.origin_any")
                  ? t("shipping.origin_suggested", { name: originPreview[0].label })
                  : t("shipping.origin_warehouse_hint")}
              </s-text>
            </div>
          </div>
        )}

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
            {t("shipping.pricing_mode")}
          </label>
          <s-stack direction="inline" gap="base">
            <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", opacity: 1 }}>
              <input
                type="radio"
                checked={pricingMode === "flat"}
                onChange={() => setPricingMode("flat")}
              />
              {t("shipping.flat_price")}
            </label>
            <label style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              cursor: allowWeight ? "pointer" : "not-allowed",
              opacity: allowWeight ? 1 : 0.55,
            }}
            >
              <input
                type="radio"
                disabled={!allowWeight}
                checked={pricingMode === "weight_tiers"}
                onChange={() => {
                  if (!allowWeight) return;
                  setPricingMode("weight_tiers");
                  if (weightTiers.length === 0) {
                    setWeightTiers([{ minKg: 0, maxKg: 5, price: 10000 }, { minKg: 5, maxKg: 15, price: 20000 }]);
                  }
                }}
              />
              {t("shipping.by_weight")}
            </label>
            <label style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              cursor: allowCart ? "pointer" : "not-allowed",
              opacity: allowCart ? 1 : 0.55,
            }}
            >
              <input
                type="radio"
                disabled={!allowCart}
                checked={pricingMode === "cart_total"}
                onChange={() => {
                  if (!allowCart) return;
                  setPricingMode("cart_total");
                  if (cartTotalTiers.length === 0) {
                    setCartTotalTiers([
                      { minAmount: 0, maxAmount: 100000, price: 15000 },
                      { minAmount: 100000, maxAmount: 200000, price: 10000 },
                      { minAmount: 200000, maxAmount: 500000, price: 0 },
                    ]);
                  }
                }}
              />
              {t("shipping.by_cart_total")}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
              <input
                type="radio"
                checked={pricingMode === "per_item"}
                onChange={() => setPricingMode("per_item")}
              />
              {t("shipping.per_item")}
            </label>
          </s-stack>
          {(!allowWeight || !allowCart) && <ProFeatureNotice t={t} />}
        </div>

        {pricingMode === "per_item" && (
          <div>
            <s-stack direction="inline" gap="base">
              <s-text-field
                label={t("shipping.per_item_first", { currency })}
                name="price"
                type="number"
                step="any"
                min="0"
                value={String(rate?.price || "")}
                required
                style={{ maxWidth: "160px" }}
              />
              <s-text-field
                label={t("shipping.per_item_extra", { currency })}
                name="perItemPrice"
                type="number"
                step="any"
                min="0"
                value={rate?.perItemPrice != null ? String(rate.perItemPrice) : ""}
                style={{ maxWidth: "160px" }}
              />
            </s-stack>
            <div style={{ marginTop: 4 }}>
              <s-text variant="bodySm" tone="subdued">{t("shipping.per_item_hint")}</s-text>
            </div>
          </div>
        )}

        {pricingMode === "weight_tiers" && (
          <WeightTierEditor tiers={weightTiers} onChange={setWeightTiers} t={t} />
        )}

        {pricingMode === "cart_total" && (
          <CartTotalTierEditor tiers={cartTotalTiers} onChange={setCartTotalTiers} t={t} />
        )}

        <s-text-field
          label={t("shipping.description_opt")}
          name="description"
          value={rate?.description || ""}
        />

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
            {t("shipping.delivery_estimate")}
          </label>
          <s-stack direction="inline" gap="base" style={{ alignItems: "center" }}>
            <s-text-field
              label={t("shipping.delivery_min")}
              name="minDeliveryDays"
              type="number"
              min="0"
              step="1"
              value={rate?.minDeliveryDays != null ? String(rate.minDeliveryDays) : ""}
              style={{ maxWidth: "110px" }}
            />
            <s-text-field
              label={t("shipping.delivery_max")}
              name="maxDeliveryDays"
              type="number"
              min="0"
              step="1"
              value={rate?.maxDeliveryDays != null ? String(rate.maxDeliveryDays) : ""}
              style={{ maxWidth: "110px" }}
            />
            <s-text variant="bodySm" tone="subdued">{t("shipping.delivery_hint")}</s-text>
          </s-stack>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
            {t("shipping.city_condition")}
          </label>
          <s-stack direction="inline" gap="base">
            {["all", "include", "exclude"].map((cond) => (
              <label key={cond} style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="cityCondition"
                  value={cond}
                  checked={cityCondition === cond}
                  onChange={() => setCityCondition(cond)}
                />
                {cond === "all" && t("shipping.all_cities")}
                {cond === "include" && t("shipping.only_cities")}
                {cond === "exclude" && t("shipping.all_except")}
              </label>
            ))}
          </s-stack>
        </div>

        {cityCondition !== "all" && (
          <CityPicker
            department={department}
            selectedCities={selectedCities}
            onChange={setSelectedCities}
            aliases={cityAliases}
            onAliasesChange={setCityAliases}
          />
        )}
        {/* Hidden: ciudades como texto separado por comas para el action */}
        <input type="hidden" name="cities_input" value={selectedCities.join(", ")} />
        {/* Hidden: alias por ciudad (JSON) para homologación fuzzy en checkout */}
        <input type="hidden" name="city_aliases_input" value={JSON.stringify(cityAliases)} />

        {/* Preview en vivo de la bodega de origen (display only) */}
        {originPreview && (
          <div style={{ background: "#EEEDFE", border: "1px solid #AFA9EC", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#3C3489", marginBottom: originPreview.length > 1 ? 6 : 0 }}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M10 2 2 6v12h5v-5h6v5h5V6l-8-4Z"/>
              </svg>
              {t("shipping.origin_warehouse")}
            </div>
            {originPreview.length === 1 ? (
              <span style={{ fontSize: 13, color: "#3C3489", fontWeight: 500 }}>{originPreview[0].label}</span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {originPreview.map((p) => (
                  <span key={p.dept} style={{ fontSize: 12, color: "#3C3489" }}>
                    <strong>{p.dept}:</strong> {p.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
            {t("shipping.product_condition")}
          </label>
          <s-stack direction="inline" gap="base">
            {["all", "include", "exclude"].map((cond) => {
              const locked = cond !== "all" && !allowProductTags;
              return (
                <label
                  key={cond}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    cursor: locked ? "not-allowed" : "pointer",
                    opacity: locked ? 0.55 : 1,
                  }}
                >
                  <input
                    type="radio"
                    disabled={locked}
                    checked={productCondition === cond}
                    onChange={() => {
                      if (locked) return;
                      setProductCondition(cond);
                    }}
                  />
                  {cond === "all" && t("shipping.all_products")}
                  {cond === "include" && t("shipping.product_include")}
                  {cond === "exclude" && t("shipping.product_exclude")}
                </label>
              );
            })}
          </s-stack>
          {!allowProductTags && <ProFeatureNotice t={t} />}
        </div>

        {productCondition !== "all" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {productConditions.map((condition, index) => {
              const updateCondition = (changes) => {
                setProductConditions((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, ...changes } : item));
              };
              return (
                <div key={index}>
                  {index > 0 && (
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      margin: "2px 0 10px",
                    }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#3C3489" }}>
                        {t("shipping.product_join_label")}
                      </label>
                      <select
                        value={condition.join === "or" ? "or" : "and"}
                        onChange={(event) => updateCondition({ join: event.target.value })}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid #AFA9EC",
                          background: "#EEEDFE",
                          color: "#3C3489",
                          fontWeight: 700,
                          fontSize: 12,
                        }}
                      >
                        <option value="and">{t("shipping.product_logic_and_short")}</option>
                        <option value="or">{t("shipping.product_logic_or_short")}</option>
                      </select>
                    </div>
                  )}
                  <div style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: 12, background: "#fafafa" }}>
                    <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                      <div>
                        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 4 }}>
                          {t("shipping.product_field")}
                        </label>
                        <select
                          value={condition.field}
                          onChange={(event) => updateCondition({ field: event.target.value })}
                          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", minWidth: 160 }}
                        >
                          <option value="tags">{t("shipping.field_tags")}</option>
                          <option value="vendor">{t("shipping.field_vendor")}</option>
                          <option value="product_type">{t("shipping.field_product_type")}</option>
                          <option value="collection">{t("shipping.field_collection")}</option>
                          <option value="sku">{t("shipping.field_sku")}</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 4 }}>
                          {t("shipping.product_match_mode")}
                        </label>
                        <select
                          value={condition.matchMode}
                          onChange={(event) => updateCondition({ matchMode: event.target.value })}
                          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", minWidth: 220 }}
                        >
                          <option value="any">{t("shipping.match_any")}</option>
                          <option value="all">{t("shipping.match_all")}</option>
                        </select>
                      </div>
                      {productConditions.length > 1 && (
                        <s-button
                          type="button"
                          variant="tertiary"
                          tone="critical"
                          onClick={() => setProductConditions((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          {t("shipping.remove_product_condition")}
                        </s-button>
                      )}
                    </s-stack>
                    <div style={{ marginTop: 8 }}>
                      <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 4 }}>
                        {t("shipping.product_values_label")}
                      </label>
                      <ProductTagInput
                        tags={condition.values}
                        onChange={(values) => updateCondition({ values })}
                        placeholder={t(`shipping.product_values_placeholder_${condition.field}`)}
                      />
                      {condition.field === "collection" && (
                        <s-text variant="bodySm" tone="subdued">{t("shipping.collection_hint")}</s-text>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <div>
              <s-button
                type="button"
                variant="secondary"
                onClick={() => setProductConditions((current) => [
                  ...current,
                  { field: "tags", matchMode: "any", values: [], join: "and" },
                ])}
              >
                {t("shipping.add_product_condition")}
              </s-button>
            </div>
          </div>
        )}

        <div style={{ opacity: allowSchedule ? 1 : 0.85 }}>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
            {t("shipping.schedule")}
          </label>
          <s-stack direction="inline" gap="base">
            <input
              type="time"
              name="timeFrom"
              defaultValue={rate?.timeFrom || ""}
              disabled={!allowSchedule}
              style={{ padding: "6px 10px", borderRadius: "8px", border: "1px solid #ccc" }}
            />
            <span style={{ alignSelf: "center" }}>{t("shipping.schedule_to")}</span>
            <input
              type="time"
              name="timeTo"
              defaultValue={rate?.timeTo || ""}
              disabled={!allowSchedule}
              style={{ padding: "6px 10px", borderRadius: "8px", border: "1px solid #ccc" }}
            />
          </s-stack>
          <s-text variant="bodySm" tone="subdued">
            {t("shipping.schedule_hint")}
          </s-text>
          {!allowSchedule && <ProFeatureNotice t={t} />}
        </div>

        <div style={{ opacity: allowSchedule ? 1 : 0.85 }}>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
            {t("shipping.days_of_week")}
          </label>
          <s-stack direction="inline" gap="base">
            {getDaysOfWeek(t).map((d) => {
              const currentDays = JSON.parse(rate?.daysOfWeek || "[]");
              return (
                <label
                  key={d.value}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    cursor: allowSchedule ? "pointer" : "not-allowed",
                    opacity: allowSchedule ? 1 : 0.55,
                  }}
                >
                  <input
                    type="checkbox"
                    name="daysOfWeek"
                    value={d.value}
                    defaultChecked={currentDays.includes(d.value)}
                    disabled={!allowSchedule}
                  />
                  {d.label}
                </label>
              );
            })}
          </s-stack>
          <s-text variant="bodySm" tone="subdued">
            {t("shipping.days_hint")}
          </s-text>
        </div>

        <div style={{
          padding: "10px 12px",
          borderRadius: 8,
          background: "#f6f6f7",
          border: "1px solid #e3e3e3",
          fontSize: 12,
          color: "#444",
          lineHeight: 1.5,
        }}>
          <strong>{t("shipping.required_title")}</strong>
          <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
            <li>{t("shipping.required_name")}</li>
            <li>{t("shipping.required_service")}</li>
            <li>{t("shipping.required_price", { currency })}</li>
          </ul>
          <div style={{ marginTop: 6, color: "#6d7175" }}>
            {t("shipping.required_optional_hint")}
          </div>
        </div>

        <s-stack direction="inline" gap="base">
          <s-button type="submit" variant="primary" loading={isSaving} disabled={planBlocksSave}>
            {isEditing ? t("shipping.update_rate") : t("shipping.add_rate")}
          </s-button>
          {onCancel && (
            <s-button type="button" variant="secondary" onClick={onCancel}>
              {t("shipping.close_without_saving")}
            </s-button>
          )}
        </s-stack>
      </s-stack>
    </fetcher.Form>
  );
}

function RateCard({ rate, zoneId, zoneSlug, department, t, planInfo, enabledServices }) {
  const deleteFetcher = useFetcher();
  const duplicateFetcher = useFetcher();
  const toggleFetcher = useFetcher();
  const isDuplicating = duplicateFetcher.state !== "idle";
  const isToggling = toggleFetcher.state !== "idle";
  const currency = useShopCurrency();
  const warehouses = useWarehouses();
  const [editing, setEditing] = useState(false);
  const isDeleting = deleteFetcher.state !== "idle";

  // Bodega de origen derivada por ubicación (provincia de la zona). Display
  // only — no afecta checkout ni el routing de Shopify.
  // Bodega de origen ASIGNADA (warehouseId funcional): en checkout solo aplican
  // las tarifas cuyo origen resuelto coincide. null = aplica a cualquier origen.
  const assignedWarehouse = rate.warehouseId ? warehouses.find((w) => w.id === rate.warehouseId) : null;
  const assignedMissing = Boolean(rate.warehouseId) && !assignedWarehouse;

  const cities = JSON.parse(rate.cities || "[]");
  const conditionLabel =
    rate.cityCondition === "all" ? t("shipping.all_cities_label") :
    rate.cityCondition === "include" ? t("shipping.only_label").replace("{{cities}}", cities.join(", ")) :
    t("shipping.except_label").replace("{{cities}}", cities.join(", "));

  const isProductInclude = rate.productCondition === "include" || rate.productCondition === "include_tags";
  let productConditionsSummary = [];
  try {
    productConditionsSummary = JSON.parse(rate.productConditions || "[]");
  } catch {
    productConditionsSummary = [];
  }
  if (!Array.isArray(productConditionsSummary) || productConditionsSummary.length === 0) {
    const pTags = (() => {
      try { return JSON.parse(rate.productTags || "[]"); } catch { return []; }
    })();
    if (pTags.length) {
      productConditionsSummary = [{
        field: rate.productField || "tags",
        matchMode: rate.productMatchMode || "any",
        values: pTags,
      }];
    }
  }
  const productParts = productConditionsSummary.map((condition, index) => {
    const fieldLabel = t(`shipping.field_${condition.field || "tags"}`);
    const modeLabel = condition.matchMode === "all" ? ` (${t("shipping.match_all_short")})` : "";
    const values = Array.isArray(condition.values) ? condition.values.join(", ") : "";
    const part = `${fieldLabel}: ${values}${modeLabel}`;
    if (index === 0) return part;
    const joinLabel = (condition.join === "or"
      || (!condition.join && rate.productConditionLogic === "or"))
      ? t("shipping.product_logic_or_short")
      : t("shipping.product_logic_and_short");
    return `${joinLabel} ${part}`;
  });
  const productLabel = rate.productCondition === "all" || productParts.length === 0 ? null
    : `${isProductInclude ? t("shipping.product_include_label") : t("shipping.product_exclude_label")} ${productParts.join(" ")}`;

  const days = JSON.parse(rate.daysOfWeek || "[]");
  const dayLabels = days.map((d) => getDaysOfWeek(t).find((dw) => dw.value === d)?.label || d);
  const scheduleLabel = rate.timeFrom || rate.timeTo
    ? `${rate.timeFrom || "00:00"} – ${rate.timeTo || "23:59"}${days.length ? ` (${dayLabels.join(", ")})` : ""}`
    : null;

  const isWeightTiers = rate.pricingMode === "weight_tiers";
  const isCartTotal = rate.pricingMode === "cart_total";
  const isPerItem = rate.pricingMode === "per_item";
  const weightTiersList = isWeightTiers ? JSON.parse(rate.weightTiers || "[]") : [];
  const cartTotalTiersList = isCartTotal ? JSON.parse(rate.cartTotalTiers || "[]") : [];

  if (editing) {
    return (
      <s-card>
        <RateForm
          rate={rate}
          zoneId={zoneId}
          zoneSlug={zoneSlug}
          department={department}
          onCancel={() => setEditing(false)}
          t={t}
          planLimits={planInfo.limits}
          enabledServices={enabledServices}
        />
      </s-card>
    );
  }

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: "8px 16px",
      alignItems: "start",
      padding: "12px 16px",
      borderRadius: "10px",
      border: "1px solid #e3e3e3",
      background: "#fff",
      opacity: rate.enabled ? 1 : 0.55,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: "14px" }}>{rate.name}</span>
          <s-badge tone={rate.enabled ? "success" : undefined}>
            {getServiceCodes(t).find((s) => s.value === rate.serviceCode)?.label || rate.serviceCode}
          </s-badge>
          {isWeightTiers ? (
            <s-badge tone="info">{t("shipping.by_weight")}</s-badge>
          ) : isCartTotal ? (
            <s-badge tone="info">{t("shipping.by_cart_total")}</s-badge>
          ) : isPerItem ? (
            <>
              <s-badge tone="info">{t("shipping.per_item")}</s-badge>
              <span style={{ fontWeight: 700, fontSize: "14px" }}>
                {formatMoney(rate.price, currency)}
                <span style={{ fontWeight: 400, fontSize: "12px", color: "#666" }}>
                  {" "}+ {formatMoney(rate.perItemPrice || 0, currency)} {t("shipping.per_item_each")}
                </span>
              </span>
            </>
          ) : (
            <span style={{ fontWeight: 700, fontSize: "14px" }}>
              {rate.price > 0 ? formatMoney(rate.price, currency) : t("shipping.free")}
            </span>
          )}
        </div>
        {isWeightTiers && weightTiersList.length > 0 && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", fontSize: "11px" }}>
            {weightTiersList.map((tier, i) => (
              <span key={i} style={{
                padding: "2px 8px", borderRadius: "4px",
                background: "#f0f4ff", border: "1px solid #d0d8f0",
              }}>
                {tier.minKg}–{tier.maxKg}kg: {formatMoney(tier.price, currency)}
              </span>
            ))}
          </div>
        )}
        {isCartTotal && cartTotalTiersList.length > 0 && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", fontSize: "11px" }}>
            {cartTotalTiersList.map((tier, i) => {
              const maxLabel = !tier.maxAmount || tier.maxAmount === 0
                ? "+"
                : `–${formatMoney(tier.maxAmount, currency)}`;
              return (
                <span key={i} style={{
                  padding: "2px 8px", borderRadius: "4px",
                  background: "#f0fff4", border: "1px solid #b2dfdb",
                }}>
                  {formatMoney(tier.minAmount, currency)}{maxLabel}: {tier.price > 0 ? formatMoney(tier.price, currency) : t("shipping.free")}
                </span>
              );
            })}
          </div>
        )}
        {(warehouses.length > 1 || assignedWarehouse || assignedMissing) && (
          <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true" style={{ color: assignedMissing ? "#b45309" : "#6b6b68" }}>
              <path d="M10 2 2 6v12h5v-5h6v5h5V6l-8-4Z"/>
            </svg>
            {assignedMissing ? (
              <span style={{ color: "#b45309" }}>{t("shipping.origin_unavailable")}</span>
            ) : assignedWarehouse ? (
              <span style={{ color: "#3C3489", fontWeight: 500 }}>{assignedWarehouse.name}</span>
            ) : (
              <span style={{ color: "#9b9b98", fontStyle: "italic" }}>{t("shipping.origin_all")}</span>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "12px", color: "#666" }}>
          <span>{conditionLabel}</span>
          {productLabel && <span>· {productLabel}</span>}
          {scheduleLabel && <span>· {scheduleLabel}</span>}
          {rate.minDeliveryDays != null && (
            <span>
              · {rate.minDeliveryDays === rate.maxDeliveryDays
                ? t("shipping.delivery_days_single", { n: rate.minDeliveryDays })
                : t("shipping.delivery_days_range", { min: rate.minDeliveryDays, max: rate.maxDeliveryDays ?? rate.minDeliveryDays })}
            </span>
          )}
          {rate.description && <span>· {rate.description}</span>}
        </div>
      </div>
      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
        <toggleFetcher.Form method="post" style={{ display: "flex", alignItems: "center" }}>
          <input type="hidden" name="_intent" value="toggle_rate" />
          <input type="hidden" name="rateId" value={rate.id} />
          <input type="hidden" name="enabled" value={rate.enabled ? "false" : "true"} />
          <s-button
            type="submit"
            variant="tertiary"
            size="small"
            loading={isToggling}
            title={rate.enabled ? t("shipping.disable_rate") : t("shipping.enable_rate")}
          >
            {rate.enabled ? t("shipping.disable_rate") : t("shipping.enable_rate")}
          </s-button>
        </toggleFetcher.Form>
        <s-button variant="tertiary" size="small" onClick={() => setEditing(true)}>{t("shipping.edit")}</s-button>
        <duplicateFetcher.Form method="post">
          <input type="hidden" name="_intent" value="duplicate_rate" />
          <input type="hidden" name="rateId" value={rate.id} />
          <input type="hidden" name="zoneId" value={zoneId} />
          <s-button type="submit" variant="tertiary" size="small" loading={isDuplicating} title={t("shipping.duplicate")}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M7 4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1V4Zm1 1h3a2 2 0 0 1 2 2v5h1a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v1ZM6 6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H6Z"/>
            </svg>
          </s-button>
        </duplicateFetcher.Form>
        <deleteFetcher.Form method="post">
          <input type="hidden" name="_intent" value="delete_rate" />
          <input type="hidden" name="rateId" value={rate.id} />
          <s-button type="submit" variant="tertiary" size="small" tone="critical" loading={isDeleting}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M8 3.994C8 2.893 8.895 2 10 2s2 .893 2 1.994h3.5a.5.5 0 0 1 0 1h-.847l-.799 9.586A2 2 0 0 1 11.861 16H8.139a2 2 0 0 1-1.993-1.42L5.347 4.994H4.5a.5.5 0 0 1 0-1H8Zm1 0h2c0-.549-.449-.994-1-.994s-1 .445-1 .994ZM6.354 4.994l.78 9.349A1 1 0 0 0 8.14 15h3.722a1 1 0 0 0 .997-.657l.78-9.349H6.354Z"/>
            </svg>
          </s-button>
        </deleteFetcher.Form>
      </div>
    </div>
  );
}

function ZoneServicesEditor({ zone, enabledServices, t }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(enabledServices);
  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (!isSaving && fetcher.data?.success) {
      setOpen(false);
    }
  }, [isSaving, fetcher.data]);

  const allCodes = getServiceCodes(t);
  const labels = enabledServices
    .map((code) => allCodes.find((c) => c.value === code)?.label || code)
    .join(" · ");

  const toggle = (code) => {
    setDraft((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  if (!open) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, padding: "8px 12px", borderRadius: 8,
        background: "#f6f6f7", border: "1px solid #e3e3e3", fontSize: 12,
      }}>
        <span>
          <strong>{t("shipping.zone_services_label")}:</strong> {labels || "—"}
        </span>
        <s-button variant="tertiary" size="small" onClick={() => { setDraft(enabledServices); setOpen(true); }}>
          {t("shipping.zone_services_edit")}
        </s-button>
      </div>
    );
  }

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="_intent" value="update_zone_services" />
      <input type="hidden" name="zoneId" value={zone.id} />
      {draft.map((code) => (
        <input key={code} type="hidden" name="enabledServices" value={code} />
      ))}
      <div style={{
        display: "flex", flexDirection: "column", gap: 10,
        padding: "12px 14px", borderRadius: 8,
        background: "#fff", border: "1px solid #d0d4d9",
      }}>
        <s-text variant="headingSm">{t("shipping.zone_services_title")}</s-text>
        <s-text variant="bodySm" tone="subdued">{t("shipping.zone_services_desc")}</s-text>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {allCodes.map((sc) => (
            <label key={sc.value} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={draft.includes(sc.value)}
                onChange={() => toggle(sc.value)}
              />
              {sc.label}
            </label>
          ))}
        </div>
        {draft.length === 0 && (
          <s-text variant="bodySm" tone="critical">{t("shipping.zone_services_empty")}</s-text>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <s-button type="submit" variant="primary" loading={isSaving} disabled={draft.length === 0}>
            {t("shipping.zone_services_save")}
          </s-button>
          <s-button variant="tertiary" onClick={() => setOpen(false)}>
            {t("shipping.cancel")}
          </s-button>
        </div>
      </div>
    </fetcher.Form>
  );
}

function ZoneSection({ zone, t, planInfo, shopCountry, countryName, searchQuery = "", onAddRate, dupTargets = [] }) {
  const currency = useShopCurrency();
  const isForeign = zone.country && shopCountry && zone.country !== shopCountry;
  const deleteFetcher = useFetcher();
  const duplicateZoneFetcher = useFetcher();
  const isDuplicatingZone = duplicateZoneFetcher.state !== "idle";
  const isDeleting = deleteFetcher.state !== "idle";
  const canAddRate = zone.rates.length < planInfo.limits.maxRatesPerZone;
  // Acordeón: colapsado por defecto, se ve todo al desplegar.
  const [open, setOpen] = useState(false);
  // Filtro de búsqueda: por nombre de tarifa o nombre del departamento.
  const q = (searchQuery || "").trim().toLowerCase();
  const deptMatches = !q || zone.department.toLowerCase().includes(q);
  const visibleRates = !q
    ? zone.rates
    : deptMatches
      ? zone.rates
      : zone.rates.filter((r) => (r.name || "").toLowerCase().includes(q));
  const enabledServices = useMemo(() => {
    try {
      const parsed = JSON.parse(zone.enabledServices || "[]");
      return Array.isArray(parsed) && parsed.length > 0
        ? parsed
        : ["mox_envio", "mox_express", "mox_pickup"];
    } catch {
      return ["mox_envio", "mox_express", "mox_pickup"];
    }
  }, [zone.enabledServices]);

  // Con búsqueda activa, ocultar el depto entero si nada matchea (depto ni
  // rate). Va DESPUÉS de todos los hooks para no romper las reglas de hooks.
  if (q && !deptMatches && visibleRates.length === 0) return null;

  // Buscando → forzar abierto para que la tarifa que matchea sea visible.
  const isOpen = open || !!q;
  const deptLabel = isForeign
    ? `${zone.department} — ${countryName ? countryName(zone.country) : zone.country}`
    : zone.department;

  return (
    <s-section>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16"
          fill="currentColor" aria-hidden="true"
          style={{ color: "#6b6b68", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
        >
          <path d="M7 5l6 5-6 5V5Z" />
        </svg>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{deptLabel}</span>
        <s-badge>{t("shipping.rate_count", { n: zone.rates.length })}</s-badge>
        <s-button
          variant="tertiary"
          size="small"
          disabled={!canAddRate}
          onClick={(e) => { e.stopPropagation(); onAddRate?.(zone); }}
        >
          {t("shipping.add_rate")}
        </s-button>
      </div>

      {isOpen && (
        <s-stack direction="block" gap="base">
          {isForeign && (
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.zone_currency_note", { currency })}
            </s-text>
          )}
          <ZoneServicesEditor zone={zone} enabledServices={enabledServices} t={t} />
          {visibleRates.map((rate) => (
            <RateCard key={rate.id} rate={rate} zoneId={zone.id} zoneSlug={zone.slug} department={zone.department} t={t} planInfo={planInfo} enabledServices={enabledServices} />
          ))}

          {zone.rates.length === 0 && (
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.no_rates_zone")}
            </s-text>
          )}

          {!canAddRate && (
            <s-text variant="bodySm" tone="subdued">{t("shipping.limit_rates_per_zone_ui")}</s-text>
          )}

          {/* Duplicar zona: copia todas las tarifas hacia otro departamento del
              catálogo (excluye los que ya tienen zona — sin errores de tipeo). */}
          {dupTargets.length > 0 && (
            <duplicateZoneFetcher.Form method="post">
              <input type="hidden" name="_intent" value="duplicate_zone" />
              <input type="hidden" name="zoneId" value={zone.id} />
              <s-stack direction="inline" gap="small-200" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "#666" }}>{t("shipping.duplicate_zone_label")}</span>
                <select name="target_department" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #ccc", fontSize: 13 }}>
                  {dupTargets.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                <s-button type="submit" variant="secondary" size="small" loading={isDuplicatingZone}>
                  {t("shipping.duplicate_zone_btn")}
                </s-button>
              </s-stack>
            </duplicateZoneFetcher.Form>
          )}

          <deleteFetcher.Form method="post">
            <input type="hidden" name="_intent" value="delete_zone" />
            <input type="hidden" name="zoneId" value={zone.id} />
            <s-button type="submit" variant="tertiary" tone="critical" loading={isDeleting}>
              {t("shipping.delete_zone").replace("{{dept}}", zone.department)}
            </s-button>
          </deleteFetcher.Form>
        </s-stack>
      )}
    </s-section>
  );
}

// --- CSV Export ---

/**
 * Plantilla de ejemplo para el merchant: una fila por feature (tarifa fija,
 * ciudades+horario, rangos de peso, envío gratis por monto, condición de
 * producto, multi-país). Los datos son neutros; solo el encabezado se traduce.
 */
function generateTemplateCSV(locale) {
  // Filas como objetos por key → se serializan en el orden de CSV_COLUMNS, así
  // reordenar columnas no descuadra la plantilla. Campos omitidos = vacío.
  const rows = [
    { department: "Antioquia", rate_name: "Envío estándar", service_type: "mox_envio", pricing_mode: "flat", price: "12000", city_condition: "all", description: "Entrega en todo el departamento", product_condition: "all", delivery_min_days: "2", delivery_max_days: "4", product_field: "tags", product_match_mode: "any", country: "CO" },
    { department: "Antioquia", rate_name: "Envío express", service_type: "mox_express", pricing_mode: "flat", price: "20000", city_condition: "include", cities: "MEDELLÍN,ENVIGADO,SABANETA", description: "Solo área metropolitana", from_time: "08:00", to_time: "18:00", days: "mon,tue,wed,thu,fri", product_condition: "all", delivery_min_days: "1", delivery_max_days: "1", product_field: "tags", product_match_mode: "any", country: "CO", warehouse: "Bodega Medellín", city_aliases: "MEDELLÍN>medallo|medall;ENVIGADO>envig" },
    { department: "Cundinamarca", rate_name: "Envío por peso", service_type: "mox_envio", pricing_mode: "weight_tiers", weight_ranges: "0-5:10000;5-15:20000", city_condition: "all", product_condition: "all", delivery_min_days: "2", delivery_max_days: "5", product_field: "tags", product_match_mode: "any", country: "CO" },
    { department: "Cundinamarca", rate_name: "Gratis desde 200.000", service_type: "mox_envio", pricing_mode: "cart_total", cart_ranges: "0-200000:15000;200000-0:0", city_condition: "all", product_condition: "all", delivery_min_days: "2", delivery_max_days: "5", product_field: "tags", product_match_mode: "any", country: "CO" },
    { department: "Antioquia", rate_name: "Refrigerado", service_type: "mox_envio", pricing_mode: "flat", price: "25000", city_condition: "all", description: "Cadena de frío", product_condition: "include", product_tags: "congelados", delivery_min_days: "1", delivery_max_days: "2", product_field: "collection", product_match_mode: "all", country: "CO" },
    { department: "Antioquia", rate_name: "Envío por ítem", service_type: "mox_envio", pricing_mode: "per_item", price: "10000", per_item_price: "2000", city_condition: "all", description: "Primer ítem 10.000 + 2.000 c/u adicional", product_condition: "all", delivery_min_days: "2", delivery_max_days: "4", product_field: "tags", product_match_mode: "any", country: "CO" },
    { department: "Jalisco", rate_name: "Envío MX", service_type: "mox_envio", pricing_mode: "flat", price: "150", city_condition: "all", product_condition: "all", delivery_min_days: "3", delivery_max_days: "6", product_field: "tags", product_match_mode: "any", country: "MX" },
  ];
  const serialize = (r) => CSV_COLUMNS.map((c) => csvField(r[c.key] ?? "")).join(",");
  return [getCSVHeaders(locale), ...rows.map(serialize)].join("\n");
}

// Referencia de columnas para la guía del CSV. `desc` es clave i18n; valores y
// ejemplos son códigos/formatos (no se traducen).
const CSV_HELP_COLUMNS = [
  { es: "departamento", en: "department", values: "", example: "Antioquia" },
  { es: "nombre_tarifa", en: "rate_name", values: "", example: "Envío estándar" },
  { es: "tipo_servicio", en: "service_type", values: "mox_envio | mox_express | mox_pickup", example: "mox_envio" },
  { es: "modo_precio", en: "pricing_mode", values: "flat | weight_tiers | cart_total | per_item", example: "flat" },
  { es: "precio", en: "price", values: "", example: "12000" },
  { es: "rangos_peso", en: "weight_ranges", values: "minKg-maxKg:precio;…", example: '"0-5:10000;5-15:20000"' },
  { es: "rangos_monto", en: "cart_ranges", values: "min-max:precio;… (max 0 = sin tope)", example: '"0-200000:15000;200000-0:0"' },
  { es: "precio_item_adicional", en: "per_item_price", values: "", example: "2000" },
  { es: "condicion_ciudad", en: "city_condition", values: "all | include | exclude", example: "include" },
  { es: "ciudades", en: "cities", values: "", example: '"MEDELLÍN,ENVIGADO"' },
  { es: "descripcion", en: "description", values: "", example: "Entrega 24h" },
  { es: "hora_desde / hora_hasta", en: "from_time / to_time", values: "HH:MM", example: "08:00 / 18:00" },
  { es: "dias", en: "days", values: "mon…sun", example: '"mon,tue,wed,thu,fri"' },
  { es: "condicion_producto", en: "product_condition", values: "all | include | exclude", example: "include" },
  { es: "tags_producto", en: "product_tags", values: "", example: "congelados" },
  { es: "entrega_min_dias / entrega_max_dias", en: "delivery_min/max_days", values: "", example: "2 / 4" },
  { es: "campo_producto", en: "product_field", values: "tags | vendor | product_type | collection | sku", example: "collection" },
  { es: "modo_producto", en: "product_match_mode", values: "any | all", example: "any" },
  { es: "pais", en: "country", values: "ISO-2", example: "CO, MX, BR…" },
  { es: "bodega", en: "warehouse", values: "", example: "Bodega Medellín" },
  { es: "alias_ciudades", en: "city_aliases", values: "CANÓNICA>alias1|alias2;…", example: '"MEDELLÍN>medallo|medell"' },
  { es: "condiciones_producto", en: "product_conditions", values: "JSON", example: '[{\"field\":\"tags\",\"matchMode\":\"any\",\"values\":[\"fragil\"]}]' },
  { es: "logica_condiciones_producto", en: "product_condition_logic", values: "and | or", example: "and" },
];

function CsvHelp({ t, locale }) {
  return (
    <details style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: "10px 14px", background: "#fafafa" }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        {t("shipping.csv_help_title")}
      </summary>
      <div style={{ marginTop: 10, fontSize: 12.5 }}>
        <p style={{ margin: "0 0 8px", color: "#555" }}>{t("shipping.csv_help_intro")}</p>
        <ul style={{ margin: "0 0 10px 16px", padding: 0, color: "#555" }}>
          <li>{t("shipping.csv_help_tip_quotes")}</li>
          <li>{t("shipping.csv_help_tip_empty")}</li>
          <li>{t("shipping.csv_help_tip_values_field")}</li>
          <li>{t("shipping.csv_help_tip_price")}</li>
          <li>{t("shipping.csv_help_tip_ranges")}</li>
        </ul>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "4px 8px" }}>{t("shipping.csv_help_col")}</th>
                <th style={{ padding: "4px 8px" }}>{t("shipping.csv_help_desc_col")}</th>
                <th style={{ padding: "4px 8px" }}>{t("shipping.csv_help_values")}</th>
                <th style={{ padding: "4px 8px" }}>{t("shipping.csv_help_example")}</th>
              </tr>
            </thead>
            <tbody>
              {CSV_HELP_COLUMNS.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #efefef", verticalAlign: "top" }}>
                  <td style={{ padding: "4px 8px", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {locale === "en" ? c.en : c.es}
                  </td>
                  <td style={{ padding: "4px 8px", color: "#555" }}>{t(`shipping.csv_col_${i}`)}</td>
                  <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{c.values}</td>
                  <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{c.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

/** Campo de texto libre → CSV seguro: encomilla si trae coma/comilla/salto. */
function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function generateCSV(zones, locale, warehouses = []) {
  const lines = [getCSVHeaders(locale)];
  const whById = new Map((warehouses || []).map((w) => [w.id, w.name]));

  for (const zone of zones) {
    for (const rate of zone.rates) {
      const cities = JSON.parse(rate.cities || "[]");
      const days = JSON.parse(rate.daysOfWeek || "[]");
      const wTiers = JSON.parse(rate.weightTiers || "[]");
      const cTiers = JSON.parse(rate.cartTotalTiers || "[]");
      const wTiersStr = wTiers.length
        ? `"${wTiers.map((t) => `${t.minKg}-${t.maxKg}:${t.price}`).join(";")}"`
        : "";
      const cTiersStr = cTiers.length
        ? `"${cTiers.map((t) => `${t.minAmount}-${t.maxAmount}:${t.price}`).join(";")}"`
        : "";
      const pTags = JSON.parse(rate.productTags || "[]");
      let productConditions = [];
      try {
        productConditions = JSON.parse(rate.productConditions || "[]");
      } catch {
        productConditions = [];
      }
      // Alias de ciudad → "CANONICAL>a|b;CANONICAL2>c" (round-trip con el parse).
      let aliasMap = {};
      try { aliasMap = JSON.parse(rate.cityAliases || "{}") || {}; } catch { aliasMap = {}; }
      const aliasStr = Object.entries(aliasMap)
        .map(([k, v]) => `${k}>${(Array.isArray(v) ? v : []).join("|")}`)
        .join(";");
      const valueByKey = {
        department: csvField(zone.department),
        rate_name: csvField(rate.name),
        service_type: rate.serviceCode,
        pricing_mode: rate.pricingMode || "flat",
        // Precio base solo aplica a flat/per_item. En weight_tiers/cart_total el
        // valor vive en rangos_peso/rangos_monto → dejar vacío (no "0", que se
        // lee como gratis). Vacío re-importa como precio base 0 (ignorado en tiers).
        price: (rate.pricingMode === "weight_tiers" || rate.pricingMode === "cart_total") ? "" : rate.price,
        weight_ranges: wTiersStr,
        cart_ranges: cTiersStr,
        per_item_price: rate.pricingMode === "per_item" ? (rate.perItemPrice || 0) : "",
        city_condition: rate.cityCondition,
        cities: cities.length ? `"${cities.join(",")}"` : "",
        description: csvField(rate.description || ""),
        from_time: rate.timeFrom || "",
        to_time: rate.timeTo || "",
        days: days.length ? `"${days.join(",")}"` : "",
        product_condition: rate.productCondition || "all",
        product_tags: pTags.length ? `"${pTags.join(",")}"` : "",
        delivery_min_days: rate.minDeliveryDays ?? "",
        delivery_max_days: rate.maxDeliveryDays ?? "",
        product_field: rate.productField || "tags",
        product_match_mode: rate.productMatchMode || "any",
        country: zone.country || "CO",
        warehouse: csvField(rate.warehouseId ? (whById.get(rate.warehouseId) || "") : ""),
        city_aliases: aliasStr ? `"${aliasStr}"` : "",
        product_conditions: productConditions.length ? csvField(JSON.stringify(productConditions)) : "",
        product_condition_logic: rate.productConditionLogic === "or" ? "or" : "and",
      };
      lines.push(CSV_COLUMNS.map((c) => valueByKey[c.key]).join(","));
    }
  }

  return lines.join("\n");
}

function downloadCSV(content, filename) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// --- New rate modal (2-step: pick departments → fill form) ---

function NewRateModal({ subdivisionsByCountry, markets, countryName, t, planInfo, onClose, initialDepartments = [], initialCountry, initialStep = 1 }) {
  const [step, setStep] = useState(initialStep);
  const [market, setMarket] = useState(initialCountry || markets[0] || "CO");
  // Selección por NOMBRE de departamento (no zoneId): permite agregar tarifa a
  // cualquier departamento del catálogo aunque aún no tenga zona — se crea al
  // guardar. La selección es de un solo mercado: cambiar de mercado la limpia.
  const [selected, setSelected] = useState(initialDepartments);
  const toggle = (name) =>
    setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  const changeMarket = (c) => { setMarket(c); setSelected([]); };
  const selectedNames = selected.join(", ");
  const multiMarket = markets.length > 1;
  const depts = subdivisionsByCountry[market] || [];

  const overlay = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 100,
    display: "flex", alignItems: "flex-start", justifyContent: "center",
    padding: "40px 16px", overflowY: "auto",
  };
  const box = {
    background: "#fff", borderRadius: 12, border: "1px solid #e3e3e3",
    width: "100%", maxWidth: 560, flexShrink: 0,
  };
  const header = {
    display: "flex", alignItems: "center", gap: 10,
    padding: "14px 18px", borderBottom: "1px solid #e3e3e3",
  };
  const body = { padding: 18, maxHeight: "70vh", overflowY: "auto" };
  const footer = {
    padding: "12px 18px", borderTop: "1px solid #e3e3e3",
    display: "flex", justifyContent: "flex-end", gap: 8,
  };
  const checkRow = {
    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
    fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f0f0f0",
  };

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={box} role="dialog" aria-modal="true">
        <div style={header}>
          <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>
            {step === 1 ? t("shipping.new_rate_step1") : t("shipping.new_rate_step2")}
          </span>
          <s-button variant="tertiary" size="small" onClick={onClose}>✕</s-button>
        </div>

        {step === 1 ? (
          <>
            <div style={body}>
              {depts.length === 0 ? (
                <s-text tone="subdued">{t("shipping.new_rate_no_catalog")}</s-text>
              ) : (
                <s-stack direction="block" gap="small">
                  {multiMarket && (
                    <div>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                        {t("shipping.new_rate_market")}
                      </label>
                      <select
                        value={market}
                        onChange={(e) => changeMarket(e.target.value)}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", minWidth: 200, fontSize: 13 }}
                      >
                        {markets.map((c) => (
                          <option key={c} value={c}>{countryName ? countryName(c) : c}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <s-text variant="bodySm" fontWeight="semibold">
                    {t("shipping.new_rate_pick_depts")}
                  </s-text>
                  <div style={{ border: "1px solid #d1d0ce", borderRadius: 8, overflow: "hidden", maxHeight: 280, overflowY: "auto" }}>
                    {depts.map((name) => (
                      <label key={name} style={checkRow}>
                        <input
                          type="checkbox"
                          checked={selected.includes(name)}
                          onChange={() => toggle(name)}
                          style={{ width: 15, height: 15 }}
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                  <s-text variant="bodySm" tone="subdued">
                    {selected.length === 0
                      ? t("shipping.new_rate_none_selected")
                      : t("shipping.new_rate_n_selected", { n: selected.length })}
                  </s-text>
                </s-stack>
              )}
            </div>
            <div style={footer}>
              <s-button variant="tertiary" onClick={onClose}>{t("shipping.cancel")}</s-button>
              <s-button variant="primary" disabled={selected.length === 0} onClick={() => setStep(2)}>
                {t("shipping.next")}
              </s-button>
            </div>
          </>
        ) : (
          <div style={body}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 12, color: "#3C3489", background: "#EEEDFE", borderRadius: 8, padding: "8px 12px" }}>
              <span style={{ flex: 1 }}>{t("shipping.new_rate_zones_label")}: <strong>{selectedNames}</strong></span>
              <button
                type="button"
                onClick={() => setStep(1)}
                style={{ background: "none", border: "none", color: "#534AB7", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
              >
                {t("shipping.new_rate_change")}
              </button>
            </div>
            <RateForm
              createCountry={market}
              createDepartments={selected}
              department={selectedNames}
              onCancel={onClose}
              t={t}
              planLimits={planInfo.limits}
              enabledServices={["mox_envio", "mox_express", "mox_pickup"]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// --- Page ---

export default function ShippingRules() {
  const { zones: allZones, defaultZones, planInfo, planSelectionUrl, billingMode, shopCountry, shopCurrency, subdivisions, cityMatchThreshold, countries, subdivisionsByCountry, subdivisionsFull, shipsToCountries, warehouses, quoteData, quoteOnlyEmpty, quoteSearch, retentionDays } = useLoaderData();
  const { locale } = useOutletContext();
  const t = createTranslator(locale);
  const zones = allZones.filter((z) => !z.slug.startsWith("_default"));
  // Default del país de la tienda primero, luego los demás por código.
  const sortedDefaults = [...(defaultZones || [])].sort((a, b) =>
    (a.country === shopCountry ? -1 : b.country === shopCountry ? 1 : a.country.localeCompare(b.country)));
  const [defaultCountryTab, setDefaultCountryTab] = useState(shopCountry);
  const defaultZone = sortedDefaults.find((z) => z.country === defaultCountryTab) || sortedDefaults[0];
  const countryName = (code) => countries.find((c) => c.code === code)?.name || code;
  // Mercados ofrecidos en el modal "nueva tarifa": países a los que la tienda
  // vende (o el país de la tienda) + países con zonas ya creadas, filtrados a
  // los que tienen catálogo de subdivisiones. Permite agregar tarifas a
  // cualquier departamento del catálogo, no solo a zonas existentes.
  const modalMarkets = (() => {
    const zoneCountries = zones.map((z) => z.country || "CO");
    const base = shipsToCountries && shipsToCountries.length ? shipsToCountries : [shopCountry];
    const list = [...new Set([...base, ...zoneCountries])].filter(
      (c) => (subdivisionsByCountry?.[c] || []).length > 0,
    );
    return list.length ? list : [shopCountry];
  })();
  // Zonas creadas agrupadas por país, para el resumen en la pestaña Zonas.
  const zonesByCountry = (() => {
    const map = {};
    for (const z of zones) (map[z.country || "CO"] ||= []).push(z);
    return Object.entries(map).sort((a, b) =>
      a[0] === shopCountry ? -1 : b[0] === shopCountry ? 1 : a[0].localeCompare(b[0]),
    );
  })();
  const isPro = planInfo.plan === PLAN_PRO;
  const csvAllowed = planInfo.limits.csvImportExport === true;
  const createFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const carrierFetcher = useFetcher();
  const csvFetcher = useFetcher();
  const thresholdFetcher = useFetcher();
  const fileInputRef = useRef(null);
  const shopify = useAppBridge();
  const [searchParams] = useSearchParams();
  const isCreating = createFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";
  const isRegistering = carrierFetcher.state !== "idle";
  const isCsvLoading = csvFetcher.state !== "idle";

  const existingSlugs = new Set(zones.map((z) => z.slug));
  // Destinos válidos para "duplicar zona": catálogo del país de la zona menos
  // los departamentos que ya tienen zona (selector, sin errores de tipeo).
  const dupTargetsFor = (zone) => {
    const zc = (zone.country || shopCountry || "CO").toUpperCase();
    const catalog = subdivisionsByCountry?.[zc] || [];
    return catalog.filter((d) => !existingSlugs.has(zoneSlugForCountry(zc, d)));
  };
  // Pa\u00eds seleccionado en el formulario "Agregar zona" (multi-mercado).
  const [newZoneCountry, setNewZoneCountry] = useState(shopCountry);
  // Subdivisiones del pa\u00eds seleccionado. Pa\u00eds sin cat\u00e1logo \u2192 texto libre.
  const countryRegions = subdivisionsByCountry?.[newZoneCountry] || [];
  const regionList = countryRegions.length > 0 ? countryRegions
    : (newZoneCountry === shopCountry && subdivisions && subdivisions.length > 0 ? subdivisions : []);
  const hasRegionCatalog = regionList.length > 0;
  const availableDepartments = regionList.filter((d) => {
    const base = d.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const prefix = newZoneCountry && newZoneCountry !== "CO" ? `${newZoneCountry.toLowerCase()}_` : "";
    return !existingSlugs.has(prefix + base);
  });
  // Selector de pa\u00eds: solo pa\u00edses a los que la tienda VENDE (Shopify Markets).
  // Sin esa info (query fall\u00f3) \u2192 todos los del dataset. El pa\u00eds de la tienda
  // siempre est\u00e1 disponible.
  const datasetByCode = new Map(countries.map((c) => [c.code, c]));
  let countryOptions;
  if (Array.isArray(shipsToCountries) && shipsToCountries.length > 0) {
    const codes = new Set(shipsToCountries);
    codes.add(shopCountry);
    countryOptions = [...codes].sort().map((code) => datasetByCode.get(code) || { code, name: code });
  } else {
    countryOptions = countries.some((c) => c.code === shopCountry)
      ? countries
      : [{ code: shopCountry, name: shopCountry }, ...countries];
  }

  // Toast notifications
  const showToast = useCallback((data) => {
    if (data?.success) shopify.toast.show(data.message || t("shipping.toast_done"));
    if (data?.error) shopify.toast.show(data.error, { isError: true });
  }, [shopify, t]);

  useEffect(() => { showToast(createFetcher.data); }, [createFetcher.data, showToast]);
  useEffect(() => { showToast(syncFetcher.data); }, [syncFetcher.data, showToast]);
  useEffect(() => { showToast(carrierFetcher.data); }, [carrierFetcher.data, showToast]);
  useEffect(() => { showToast(csvFetcher.data); }, [csvFetcher.data, showToast]);
  useEffect(() => { showToast(thresholdFetcher.data); }, [thresholdFetcher.data, showToast]);

  const handleFileSelect = useCallback((event) => {
    if (!csvAllowed) {
      event.target.value = "";
      shopify.toast.show(t("billing.limit_feature"), { isError: true });
      return;
    }
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const fd = new FormData();
      fd.set("_intent", "upload_csv");
      fd.set("csv_content", e.target.result);
      csvFetcher.submit(fd, { method: "post" });
    };
    reader.readAsText(file);
    event.target.value = "";
  }, [csvAllowed, csvFetcher, shopify, t]);

  const handleExport = useCallback(() => {
    if (!csvAllowed) {
      shopify.toast.show(t("billing.limit_feature"), { isError: true });
      return;
    }
    const csv = generateCSV(zones, locale, warehouses);
    const filename = locale === "en" ? "shipping-rules.csv" : "reglas-envio.csv";
    downloadCSV(csv, filename);
  }, [zones, csvAllowed, shopify, t, locale, warehouses]);

  const [showAddDefault, setShowAddDefault] = useState(false);

  // Navegación por pestañas (estructura tipo mockup, Polaris-native): separa
  // la gestión de tarifas de la de zonas en lugar de una página vertical larga.
  // Pestaña inicial desde la URL (?tab) para que el filtro/paginación del log
  // de Consultar conserven la pestaña al recargar; luego es estado de cliente.
  const [activeTab, setActiveTab] = useState(searchParams.get("tab") || "zonas");
  // Búsqueda de tarifas por nombre (filtra las cards de la pestaña Tarifas).
  const [rateSearch, setRateSearch] = useState("");
  const rateQuery = rateSearch.trim().toLowerCase();
  // Modal "nueva tarifa". null = cerrada. { departments, country, step } = abierta:
  //  - botón de página → { departments: [], country, step: 1 } (elegir del catálogo)
  //  - botón dentro de una zona → { departments: [dept], country, step: 2 } (form directo)
  const [newRate, setNewRate] = useState(null);

  const canAddZone = allZones.length < planInfo.limits.maxZones;
  const canAddDefaultRate = (defaultZone?.rates.length ?? 0) < planInfo.limits.maxRatesPerZone;

  return (
    <ShopMetaContext.Provider value={{ currency: shopCurrency, subdivisions, warehouses }}>
    <s-page
      heading={t("shipping.title")}
      subtitle={t("shipping.subtitle")}
    >
      {/* Paywall banner — only visible when the merchant is not subscribed.
          Critical for App Review: without this banner the reviewer sees a
          page where the buttons are disabled but no explanation is given,
          which Shopify treats as broken behavior. Anchor uses target="_top"
          + Shopify-hosted plan selection URL (Managed Pricing) so the click
          escapes the iframe to admin.shopify.com without any fetch. */}
      {!isPro && (
        <s-section>
          <div
            style={{
              background: "linear-gradient(135deg, #fff7ed, #fde8d1)",
              border: "1px solid #f1c889",
              borderRadius: 12,
              padding: "18px 20px",
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
            role="alert"
          >
            <div style={{ maxWidth: 520 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#7c3a0c", margin: 0 }}>
                {t("billing.needs_subscription_title")}
              </div>
              <p style={{ fontSize: 13, color: "#7c3a0c", margin: "4px 0 0", lineHeight: 1.5 }}>
                {t("billing.needs_subscription_desc")}
              </p>
            </div>
            {billingMode === "managed" && planSelectionUrl ? (
              <a
                href={planSelectionUrl}
                target="_top"
                rel="noopener noreferrer"
                style={{
                  display: "inline-block",
                  padding: "10px 18px",
                  background: "#bf5b16",
                  color: "#fff",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                  cursor: "pointer",
                }}
              >
                {t("billing.needs_subscription_cta")}
              </a>
            ) : (
              <a
                href="/app/billing"
                style={{
                  display: "inline-block",
                  padding: "10px 18px",
                  background: "#bf5b16",
                  color: "#fff",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                  cursor: "pointer",
                }}
              >
                {t("billing.needs_subscription_cta")}
              </a>
            )}
          </div>
        </s-section>
      )}

      {/* ── TAB BAR (estructura tipo mockup) ── */}
      <s-section>
        <s-stack direction="inline" gap="small-200">
          <s-button
            variant={activeTab === "zonas" ? "primary" : "tertiary"}
            onClick={() => setActiveTab("zonas")}
          >
            {t("shipping.tab_zones")}
          </s-button>
          <s-button
            variant={activeTab === "tarifas" ? "primary" : "tertiary"}
            onClick={() => setActiveTab("tarifas")}
          >
            {t("shipping.tab_rates")}
          </s-button>
          <s-button
            variant={activeTab === "consultar" ? "primary" : "tertiary"}
            onClick={() => setActiveTab("consultar")}
          >
            {t("shipping.tab_query")}
          </s-button>
          <s-button
            variant={activeTab === "carga" ? "primary" : "tertiary"}
            onClick={() => setActiveTab("carga")}
          >
            {t("shipping.tab_csv")}
          </s-button>
          <s-button
            variant={activeTab === "avanzado" ? "primary" : "tertiary"}
            onClick={() => setActiveTab("avanzado")}
          >
            {t("shipping.tab_advanced")}
          </s-button>
        </s-stack>
      </s-section>

      {activeTab === "tarifas" && (
      <>
      {newRate && (
        <NewRateModal
          subdivisionsByCountry={subdivisionsByCountry}
          markets={modalMarkets}
          countryName={countryName}
          t={t}
          planInfo={planInfo}
          initialDepartments={newRate.departments}
          initialCountry={newRate.country}
          initialStep={newRate.step}
          onClose={() => setNewRate(null)}
        />
      )}
      {/* Buscador de tarifas + alta de tarifa */}
      <s-section>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="search"
            value={rateSearch}
            onChange={(e) => setRateSearch(e.target.value)}
            placeholder={t("shipping.search_rates")}
            style={{ flex: 1, padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", fontSize: "13px" }}
          />
          <s-button variant="primary" onClick={() => setNewRate({ departments: [], country: modalMarkets[0], step: 1 })}>
            {t("shipping.new_rate")}
          </s-button>
        </div>
      </s-section>

      {defaultZone && (
      <s-section heading={t("shipping.default_title")}>
        <s-stack direction="block" gap="base">
          <s-text variant="bodySm" tone="subdued">
            {t("shipping.default_desc")}
          </s-text>
          {sortedDefaults.length > 1 && (
            <s-stack direction="inline" gap="small-200">
              {sortedDefaults.map((z) => (
                <s-button
                  key={z.country}
                  variant={z.country === defaultZone.country ? "primary" : "secondary"}
                  size="small"
                  onClick={() => setDefaultCountryTab(z.country)}
                >
                  {countryName(z.country)}
                </s-button>
              ))}
            </s-stack>
          )}
          {sortedDefaults.length > 1 && (
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.default_country_note", { country: countryName(defaultZone.country) })}
            </s-text>
          )}
          {defaultZone.rates
            .filter((rate) => !rateQuery || (rate.name || "").toLowerCase().includes(rateQuery))
            .map((rate) => (
            <RateCard
              key={rate.id}
              rate={rate}
              zoneId={defaultZone.id}
              zoneSlug={defaultZone.slug}
              department={defaultZone.department}
              t={t}
              planInfo={planInfo}
              enabledServices={["mox_envio", "mox_express", "mox_pickup"]}
            />
          ))}
          {defaultZone.rates.length === 0 && (
            <div style={{
              padding: "16px", borderRadius: "8px",
              background: "#fff3cd", border: "1px solid #ffc107", fontSize: "13px",
            }}>
              {t("shipping.default_warning")}
            </div>
          )}
          {showAddDefault ? (
            <s-card>
              <RateForm
                zoneId={defaultZone.id}
                department={defaultZone.department}
                onCancel={() => setShowAddDefault(false)}
                t={t}
                planLimits={planInfo.limits}
                enabledServices={["mox_envio", "mox_express", "mox_pickup"]}
              />
            </s-card>
          ) : (
            <s-stack direction="block" gap="small">
              <s-button disabled={!canAddDefaultRate} onClick={() => setShowAddDefault(true)}>
                {t("shipping.add_default_rate")}
              </s-button>
              {!canAddDefaultRate && (
                <s-text variant="bodySm" tone="subdued">{t("shipping.limit_rates_per_zone_ui")}</s-text>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>
      )}

      {zones.map((zone) => (
        <ZoneSection key={zone.id} zone={zone} t={t} planInfo={planInfo} shopCountry={shopCountry} countryName={countryName} searchQuery={rateQuery} dupTargets={dupTargetsFor(zone)} onAddRate={(z) => setNewRate({ departments: [z.department], country: z.country || shopCountry, step: 2 })} />
      ))}
      </>
      )}

      {activeTab === "zonas" && (
      <>
      <s-section heading={t("shipping.zones_list_title")}>
        {zones.length === 0 ? (
          <s-text variant="bodySm" tone="subdued">{t("shipping.zones_list_empty")}</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {zonesByCountry.map(([country, list]) => (
              <div key={country}>
                <s-text variant="headingSm">{countryName(country)}</s-text>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {list.map((z) => (
                    <button
                      key={z.id}
                      type="button"
                      onClick={() => { setRateSearch(z.department); setActiveTab("tarifas"); }}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        fontSize: 12, padding: "4px 10px", borderRadius: 20,
                        background: "#f6f6f7", border: "1px solid #e3e3e3",
                        color: "#1a1a18", cursor: "pointer",
                      }}
                      title={t("shipping.zones_list_open")}
                    >
                      {z.department}
                      <span style={{ color: "#6b6b68" }}>· {t("shipping.rate_count", { n: z.rates.length })}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading={t("shipping.add_department")}>
        <createFetcher.Form method="post">
          <input type="hidden" name="_intent" value="create_zone" />
          <input type="hidden" name="country" value={newZoneCountry} />
          <s-stack direction="block" gap="small">
            <s-stack direction="inline" gap="base">
              <div>
                <select
                  value={newZoneCountry}
                  onChange={(e) => setNewZoneCountry(e.target.value)}
                  disabled={!canAddZone}
                  style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "140px" }}
                >
                  {countryOptions.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                {hasRegionCatalog ? (
                  <select
                    name="department"
                    disabled={!canAddZone}
                    style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "200px" }}
                  >
                    <option value="">{t("shipping.select_department")}</option>
                    {availableDepartments.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                ) : (
                  // Shop country not in our subdivision dataset — let the merchant
                  // type the region name. slug = toSlug(name) matches checkout.
                  <input
                    type="text"
                    name="department"
                    disabled={!canAddZone}
                    placeholder={t("shipping.select_department")}
                    style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "200px" }}
                  />
                )}
              </div>
              <s-button type="submit" variant="primary" loading={isCreating} disabled={!canAddZone}>
                {t("shipping.add_zone")}
              </s-button>
            </s-stack>
            {!canAddZone && (
              <s-text variant="bodySm" tone="subdued">{t("shipping.limit_zones_ui")}</s-text>
            )}
          </s-stack>
        </createFetcher.Form>
      </s-section>

      <s-section heading={t("shipping.city_match_title")}>
        <thresholdFetcher.Form method="post">
          <input type="hidden" name="_intent" value="update_threshold" />
          <s-stack direction="block" gap="small">
            <s-text variant="bodySm" tone="subdued">{t("shipping.city_match_hint")}</s-text>
            <s-stack direction="inline" gap="base">
              <input
                type="number"
                name="cityMatchThreshold"
                defaultValue={cityMatchThreshold ?? 85}
                min="50"
                max="100"
                step="1"
                style={{ width: "90px", padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", textAlign: "right" }}
              />
              <span style={{ alignSelf: "center", fontSize: "12px", color: "#666" }}>%</span>
              <s-button type="submit" variant="primary" loading={thresholdFetcher.state !== "idle"}>
                {t("shipping.city_match_save")}
              </s-button>
            </s-stack>
          </s-stack>
        </thresholdFetcher.Form>
      </s-section>

      {/* Guía: cómo nombrar las zonas en Shopify (movida desde el aside) */}
      <s-section heading={t("shipping.shopify_config")}>
        <s-box padding="base" background="bg-surface-info" borderRadius="large">
          <s-stack direction="block" gap="small">
            <s-text variant="bodySm" fontWeight="semibold">{t("shipping.zone_names_title")}</s-text>
            <s-text variant="bodySm">{t("shipping.zone_names_desc")}</s-text>
            <s-unordered-list>
              <s-list-item><s-text variant="bodySm">{t("shipping.zone_express")}</s-text></s-list-item>
              <s-list-item><s-text variant="bodySm">{t("shipping.zone_envio")}</s-text></s-list-item>
              <s-list-item><s-text variant="bodySm">{t("shipping.zone_other")}</s-text></s-list-item>
            </s-unordered-list>
            <s-text variant="bodySm" tone="caution">{t("shipping.zone_caution")}</s-text>
          </s-stack>
        </s-box>
      </s-section>
      </>
      )}

      {/* ── TAB: Consultar (simulador + log) ── */}
      {activeTab === "consultar" && (
      <QuotesView
        t={t}
        locale={locale}
        basePath="/app/shipping-rules"
        countries={countries}
        subdivisionsByCountry={subdivisionsFull}
        shopCountry={shopCountry}
        shopCurrency={shopCurrency}
        warehouses={warehouses}
        quotes={quoteData?.quotes || []}
        total={quoteData?.total || 0}
        page={quoteData?.page || 1}
        pageSize={quoteData?.pageSize || 25}
        onlyEmpty={quoteOnlyEmpty}
        search={quoteSearch}
        retentionDays={retentionDays}
      />
      )}

      {/* ── TAB: Carga masiva (CSV) ── */}
      {activeTab === "carga" && (
      <s-section heading={t("shipping.csv_title")}>
        <s-stack direction="block" gap="base">
          <s-text variant="bodySm" tone="subdued">{t("shipping.csv_desc")}</s-text>
          {!csvAllowed && (
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.csv_pro_only")}{" "}
              <s-link href="/app/billing">{t("shipping.csv_upgrade")}</s-link>
            </s-text>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            style={{ display: "none" }}
            disabled={!csvAllowed}
          />
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              disabled={!csvAllowed}
              onClick={() => csvAllowed && fileInputRef.current?.click()}
              loading={isCsvLoading}
            >
              {isCsvLoading ? t("shipping.csv_importing") : t("shipping.csv_import")}
            </s-button>
            <s-button variant="secondary" disabled={!csvAllowed} onClick={handleExport}>
              {t("shipping.csv_export")}
            </s-button>
            <s-button
              variant="tertiary"
              onClick={() => downloadCSV(generateTemplateCSV(locale), locale === "en" ? "template-shipping-rules.csv" : "plantilla-reglas-envio.csv")}
            >
              {t("shipping.csv_template")}
            </s-button>
          </s-stack>
          <CsvHelp t={t} locale={locale} />
          {csvFetcher.data?.importResults?.errors?.length > 0 && (
            <div style={{
              padding: "12px", borderRadius: "8px",
              background: "#fff3cd", border: "1px solid #ffc107", fontSize: "12px",
            }}>
              <strong>{t("shipping.csv_errors").replace("{{n}}", csvFetcher.data.importResults.errors.length)}</strong>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {csvFetcher.data.importResults.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </s-stack>
      </s-section>
      )}

      {/* ── TAB: Avanzado (antes en el aside — ahora pestaña propia para que
          el contenido principal ocupe el 100% del ancho) ── */}
      {activeTab === "avanzado" && (
      <s-section heading={t("shipping.advanced_title")}>
        <s-stack direction="block" gap="large">
          <s-text variant="bodySm" tone="subdued">
            {t("shipping.advanced_desc")}
          </s-text>

          <s-stack direction="block" gap="base">
            <s-text variant="headingSm">{t("shipping.sync_title")}</s-text>
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.sync_desc")}
            </s-text>
            <syncFetcher.Form method="post">
              <input type="hidden" name="_intent" value="sync_metafield" />
              <s-button type="submit" variant="secondary" loading={isSyncing}>
                {isSyncing ? t("shipping.sync_loading") : t("shipping.sync_button")}
              </s-button>
            </syncFetcher.Form>
          </s-stack>

          <s-stack direction="block" gap="base">
            <s-text variant="headingSm">{t("shipping.carrier_title")}</s-text>
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.carrier_desc")}
            </s-text>
            <carrierFetcher.Form method="post">
              <input type="hidden" name="_intent" value="register_carrier" />
              <s-button type="submit" variant="secondary" loading={isRegistering}>
                {isRegistering ? t("shipping.carrier_loading") : t("shipping.carrier_button")}
              </s-button>
            </carrierFetcher.Form>
          </s-stack>
        </s-stack>
      </s-section>
      )}
    </s-page>
    </ShopMetaContext.Provider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
