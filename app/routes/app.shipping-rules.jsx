import { useFetcher, useLoaderData, useOutletContext, useRouteError } from "react-router";
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
  syncRulesToMetafield,
  getOrCreateDefaultZone,
  updateZoneEnabledServices,
} from "../mox-shipping-rules.server";
import { createTranslator, getLocale } from "../utils/i18n";
import { debug, error as logError } from "../utils/logger.server";
import { ensureFletixCarrierService } from "../utils/carrier-service.server";
import { detectEnabledServicesForDepartment, getServiceAvailabilityByProvince } from "../utils/locations.server";
import { getShopPlan, checkLimit, PLAN_LIMITS } from "../utils/billing.server";
import { PLAN_FREE, PLAN_PRO } from "../utils/billing.constants";
import { getShopMeta } from "../utils/shop-record.server";
import prisma from "../db.server";

import MUNICIPALITIES from "../data/municipalities.json";
import { getSubdivisions, isSupportedCountry, formatMoney } from "../utils/geo";

// Shop currency + subdivision list, provided once at the page root so the
// nested rate/zone components format money in the shop currency and offer the
// right regions without prop-drilling. Defaults keep the legacy CO behavior.
const ShopMetaContext = createContext({ currency: "COP", subdivisions: [] });
function useShopCurrency() {
  return useContext(ShopMetaContext).currency || "COP";
}

const DEPARTMENTS = [
  "Amazonas", "Antioquia", "Arauca", "Atlántico", "Bogotá D.C.", "Bolívar",
  "Boyacá", "Caldas", "Caquetá", "Casanare", "Cauca", "Cesar", "Chocó",
  "Córdoba", "Cundinamarca", "Guainía", "Guaviare", "Huila", "La Guajira",
  "Magdalena", "Meta", "Nariño", "Norte de Santander", "Putumayo", "Quindío",
  "Risaralda", "San Andrés", "Santander", "Sucre", "Tolima", "Valle del Cauca",
  "Vaupés", "Vichada",
];

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

function getCSVHeaders(locale) {
  if (locale === "en") return "department,rate_name,service_type,price,city_condition,cities,description,from_time,to_time,days,pricing_mode,weight_ranges,cart_ranges,product_condition,product_tags,delivery_min_days,delivery_max_days,product_field,product_match_mode";
  return "departamento,nombre_tarifa,tipo_servicio,precio,condicion_ciudad,ciudades,descripcion,hora_desde,hora_hasta,dias,modo_precio,rangos_peso,rangos_monto,condicion_producto,tags_producto,entrega_min_dias,entrega_max_dias,campo_producto,modo_producto";
}

/** Parsea una línea CSV respetando campos entre comillas. */
function parseCSVLine(line) {
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
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Parsea el contenido completo del CSV y retorna rows + errors. */
function parseCSVContent(csvText, t) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { rows: [], errors: [t("csv.min_rows")] };
  }

  const firstLine = parseCSVLine(lines[0]).map((h) => h.toLowerCase().trim());
  const isHeader = firstLine.includes("departamento") || firstLine.includes("nombre_tarifa");
  const startIdx = isHeader ? 1 : 0;

  const rows = [];
  const errors = [];

  for (let i = startIdx; i < lines.length; i++) {
    const lineNum = i + 1;
    const fields = parseCSVLine(lines[i]);

    if (fields.length < 4) {
      errors.push(t("csv.missing_fields", { n: lineNum }));
      continue;
    }

    const [dept, name, serviceCode, priceStr, condition, citiesStr, description, timeFrom, timeTo, daysStr, pricingModeStr, weightTiersStr, cartTotalTiersStr, productConditionStr, productTagsStr, minDeliveryStr, maxDeliveryStr, productFieldStr, productMatchModeStr] = fields;

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
      : pricingModeStr === "cart_total" ? "cart_total" : "flat";

    const price = parseInt(priceStr, 10);
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

    rows.push({
      department: dept,
      name,
      serviceCode,
      price: isNaN(price) ? 0 : price,
      cityCondition,
      cities,
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
      minDeliveryDays: minDeliveryStr || null,
      maxDeliveryDays: maxDeliveryStr || null,
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
  let defaultZone = null;
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
    defaultZone = await getOrCreateDefaultZone(session.shop, shopMeta.country);
  } catch (e) {
    logError("[shipping-rules loader] getOrCreateDefaultZone failed:", e?.message || e);
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
  let planSelectionUrl = null;
  if (process.env.BILLING_MODE === "managed") {
    const appHandle = (process.env.APP_HANDLE || "").trim();
    const storeHandle = (session.shop || "").replace(/\.myshopify\.com$/, "");
    if (appHandle && storeHandle) {
      planSelectionUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
    }
  }

  return {
    zones,
    defaultZone,
    planInfo,
    planSelectionUrl,
    billingMode: process.env.BILLING_MODE === "managed" ? "managed" : "api",
    shopCountry: shopMeta.country,
    shopCurrency: shopMeta.currency,
    cityMatchThreshold: shopMeta.cityMatchThreshold,
    subdivisions,
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
    if (intent === "create_zone") {
      const department = formData.get("department");
      if (!department) return { error: t("action.select_department") };

      const currentZoneCount = await prisma.shippingZone.count({ where: { shop: session.shop } });
      if (!checkLimit(planInfo, "zones", currentZoneCount)) {
        return { error: t("billing.limit_zones", { max: planInfo.limits.maxZones }) };
      }

      // Auto-detect which services make sense for this department based on the
      // merchant's Shopify Locations. Falls back to all services on any failure.
      const enabledServices = await detectEnabledServicesForDepartment(admin, department);

      await createZone(session.shop, department, enabledServices, shopMeta.country);
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
      const zoneId = formData.get("zoneId");
      const pricingMode = formData.get("pricingMode") || "flat";
      const timeFrom = formData.get("timeFrom") || null;
      const timeTo = formData.get("timeTo") || null;
      const daysRaw = formData.getAll("daysOfWeek");

      if (!rateId) {
        const currentRateCount = await prisma.shippingRate.count({ where: { zoneId } });
        if (!checkLimit(planInfo, "ratesPerZone", currentRateCount)) {
          return { error: t("billing.limit_rates", { max: planInfo.limits.maxRatesPerZone }) };
        }
      }

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

      await saveRate({
        id: rateId,
        zoneId,
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
        minDeliveryDays: formData.get("minDeliveryDays"),
        maxDeliveryDays: formData.get("maxDeliveryDays"),
      });
      await syncRulesToMetafield(admin, session.shop);
      return { success: true, message: t("action.rate_saved") };
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

      // Mapa de zonas existentes por departamento
      const existingZones = await getZonesWithRates(session.shop);
      const zoneByDept = {};
      for (const z of existingZones) {
        zoneByDept[z.department] = z;
      }

      // Pre-fetch Locations once for the whole import so each new zone gets
      // its enabledServices auto-detected without N extra GraphQL calls.
      const locationsMap = await getServiceAvailabilityByProvince(admin);

      let zonesCreated = 0;
      let ratesCreated = 0;

      for (const row of rows) {
        if (!zoneByDept[row.department]) {
          const slug = row.department
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
          const enabledServices = locationsMap[slug] ?? locationsMap.default ?? [
            "mox_envio", "mox_express", "mox_pickup",
          ];
          const newZone = await createZone(session.shop, row.department, enabledServices, shopMeta.country);
          zoneByDept[row.department] = newZone;
          zonesCreated++;
        }

        await saveRate({
          zoneId: zoneByDept[row.department].id,
          shop: session.shop,
          name: row.name,
          serviceCode: row.serviceCode,
          price: row.price,
          description: row.description,
          cityCondition: row.cityCondition,
          cities: JSON.stringify(row.cities),
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

function RateForm({ rate, zoneId, department, onCancel, t, planLimits, enabledServices }) {
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
  const [productField, setProductField] = useState(rate?.productField || "tags");
  const [productMatchMode, setProductMatchMode] = useState(rate?.productMatchMode || "any");
  const [productTags, setProductTags] = useState(
    rate?.productTags ? JSON.parse(rate.productTags) : []
  );
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

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="_intent" value="save_rate" />
      <input type="hidden" name="zoneId" value={zoneId} />
      {rate?.id && <input type="hidden" name="rateId" value={rate.id} />}
      <input type="hidden" name="pricingMode" value={pricingMode} />
      <input type="hidden" name="weightTiers" value={JSON.stringify(weightTiers)} />
      <input type="hidden" name="cartTotalTiers" value={JSON.stringify(cartTotalTiers)} />
      <input type="hidden" name="productCondition" value={productCondition} />
      <input type="hidden" name="productField" value={productField} />
      <input type="hidden" name="productMatchMode" value={productMatchMode} />
      <input type="hidden" name="productTags" value={JSON.stringify(productTags)} />

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
          {pricingMode !== "flat" && (
            <input type="hidden" name="price" value="0" />
          )}
        </s-stack>

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
          </s-stack>
          {(!allowWeight || !allowCart) && <ProFeatureNotice t={t} />}
        </div>

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
          <div>
            <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                  {t("shipping.product_field")}
                </label>
                <select
                  value={productField}
                  onChange={(e) => setProductField(e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "160px" }}
                >
                  <option value="tags">{t("shipping.field_tags")}</option>
                  <option value="vendor">{t("shipping.field_vendor")}</option>
                  <option value="product_type">{t("shipping.field_product_type")}</option>
                  <option value="collection">{t("shipping.field_collection")}</option>
                  <option value="sku">{t("shipping.field_sku")}</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                  {t("shipping.product_match_mode")}
                </label>
                <select
                  value={productMatchMode}
                  onChange={(e) => setProductMatchMode(e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "200px" }}
                >
                  <option value="any">{t("shipping.match_any")}</option>
                  <option value="all">{t("shipping.match_all")}</option>
                </select>
              </div>
            </s-stack>
            <div style={{ marginTop: "8px" }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                {t("shipping.product_values_label")}
              </label>
              <ProductTagInput
                tags={productTags}
                onChange={setProductTags}
                placeholder={t(`shipping.product_values_placeholder_${productField}`)}
              />
              {productField === "collection" && (
                <s-text variant="bodySm" tone="subdued">{t("shipping.collection_hint")}</s-text>
              )}
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

function RateCard({ rate, zoneId, department, t, planInfo, enabledServices }) {
  const deleteFetcher = useFetcher();
  const duplicateFetcher = useFetcher();
  const isDuplicating = duplicateFetcher.state !== "idle";
  const currency = useShopCurrency();
  const [editing, setEditing] = useState(false);
  const isDeleting = deleteFetcher.state !== "idle";

  const cities = JSON.parse(rate.cities || "[]");
  const conditionLabel =
    rate.cityCondition === "all" ? t("shipping.all_cities_label") :
    rate.cityCondition === "include" ? t("shipping.only_label").replace("{{cities}}", cities.join(", ")) :
    t("shipping.except_label").replace("{{cities}}", cities.join(", "));

  const pTags = JSON.parse(rate.productTags || "[]");
  const isProductInclude = rate.productCondition === "include" || rate.productCondition === "include_tags";
  const productFieldLabel = t(`shipping.field_${rate.productField || "tags"}`);
  const productModeLabel = rate.productMatchMode === "all" ? t("shipping.match_all_short") : "";
  const productLabel = rate.productCondition === "all" ? null
    : `${isProductInclude ? t("shipping.product_include_label") : t("shipping.product_exclude_label")} ${productFieldLabel}: ${pTags.join(", ")}${productModeLabel ? ` (${productModeLabel})` : ""}`;

  const days = JSON.parse(rate.daysOfWeek || "[]");
  const dayLabels = days.map((d) => getDaysOfWeek(t).find((dw) => dw.value === d)?.label || d);
  const scheduleLabel = rate.timeFrom || rate.timeTo
    ? `${rate.timeFrom || "00:00"} – ${rate.timeTo || "23:59"}${days.length ? ` (${dayLabels.join(", ")})` : ""}`
    : null;

  const isWeightTiers = rate.pricingMode === "weight_tiers";
  const isCartTotal = rate.pricingMode === "cart_total";
  const weightTiersList = isWeightTiers ? JSON.parse(rate.weightTiers || "[]") : [];
  const cartTotalTiersList = isCartTotal ? JSON.parse(rate.cartTotalTiers || "[]") : [];

  if (editing) {
    return (
      <s-card>
        <RateForm
          rate={rate}
          zoneId={zoneId}
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

function ZoneSection({ zone, t, planInfo }) {
  const deleteFetcher = useFetcher();
  const [showAddRate, setShowAddRate] = useState(false);
  const isDeleting = deleteFetcher.state !== "idle";
  const canAddRate = zone.rates.length < planInfo.limits.maxRatesPerZone;
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

  return (
    <s-section heading={zone.department}>
      <s-stack direction="block" gap="base">
        <ZoneServicesEditor zone={zone} enabledServices={enabledServices} t={t} />
        {zone.rates.map((rate) => (
          <RateCard key={rate.id} rate={rate} zoneId={zone.id} department={zone.department} t={t} planInfo={planInfo} enabledServices={enabledServices} />
        ))}

        {zone.rates.length === 0 && (
          <s-text variant="bodySm" tone="subdued">
            {t("shipping.no_rates_zone")}
          </s-text>
        )}

        {showAddRate ? (
          <s-card>
            <RateForm
              zoneId={zone.id}
              department={zone.department}
              onCancel={() => setShowAddRate(false)}
              t={t}
              planLimits={planInfo.limits}
              enabledServices={enabledServices}
            />
          </s-card>
        ) : (
          <s-stack direction="block" gap="small">
            <s-button disabled={!canAddRate} onClick={() => setShowAddRate(true)}>
              {t("shipping.add_rate")}
            </s-button>
            {!canAddRate && (
              <s-text variant="bodySm" tone="subdued">{t("shipping.limit_rates_per_zone_ui")}</s-text>
            )}
          </s-stack>
        )}

        <deleteFetcher.Form method="post">
          <input type="hidden" name="_intent" value="delete_zone" />
          <input type="hidden" name="zoneId" value={zone.id} />
          <s-button type="submit" variant="tertiary" tone="critical" loading={isDeleting}>
            {t("shipping.delete_zone").replace("{{dept}}", zone.department)}
          </s-button>
        </deleteFetcher.Form>
      </s-stack>
    </s-section>
  );
}

// --- CSV Export ---

function generateCSV(zones, locale) {
  const lines = [getCSVHeaders(locale)];

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
      const fields = [
        zone.department,
        rate.name,
        rate.serviceCode,
        rate.price,
        rate.cityCondition,
        cities.length ? `"${cities.join(",")}"` : "",
        rate.description || "",
        rate.timeFrom || "",
        rate.timeTo || "",
        days.length ? `"${days.join(",")}"` : "",
        rate.pricingMode || "flat",
        wTiersStr,
        cTiersStr,
        rate.productCondition || "all",
        pTags.length ? `"${pTags.join(",")}"` : "",
        rate.minDeliveryDays ?? "",
        rate.maxDeliveryDays ?? "",
        rate.productField || "tags",
        rate.productMatchMode || "any",
      ];
      lines.push(fields.join(","));
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

// --- Page ---

export default function ShippingRules() {
  const { zones: allZones, defaultZone, planInfo, planSelectionUrl, billingMode, shopCurrency, subdivisions, cityMatchThreshold } = useLoaderData();
  const { locale } = useOutletContext();
  const t = createTranslator(locale);
  const zones = allZones.filter((z) => z.slug !== "_default");
  const isPro = planInfo.plan === PLAN_PRO;
  const csvAllowed = planInfo.limits.csvImportExport === true;
  const createFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const carrierFetcher = useFetcher();
  const csvFetcher = useFetcher();
  const thresholdFetcher = useFetcher();
  const fileInputRef = useRef(null);
  const shopify = useAppBridge();
  const isCreating = createFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";
  const isRegistering = carrierFetcher.state !== "idle";
  const isCsvLoading = csvFetcher.state !== "idle";

  const existingSlugs = new Set(zones.map((z) => z.slug));
  // Subdivisions of the shop country (from the loader). Empty when the shop
  // country isn't in our dataset \u2014 the add-zone UI then offers free-text entry.
  const regionList = subdivisions && subdivisions.length > 0 ? subdivisions : DEPARTMENTS;
  const hasRegionCatalog = subdivisions && subdivisions.length > 0;
  const availableDepartments = regionList.filter((d) => {
    const slug = d.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return !existingSlugs.has(slug);
  });

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
    const csv = generateCSV(zones, locale);
    const filename = locale === "en" ? "shipping-rules.csv" : "reglas-envio.csv";
    downloadCSV(csv, filename);
  }, [zones, csvAllowed, shopify, t]);

  const [showAddDefault, setShowAddDefault] = useState(false);

  const canAddZone = allZones.length < planInfo.limits.maxZones;
  const canAddDefaultRate = defaultZone.rates.length < planInfo.limits.maxRatesPerZone;

  return (
    <ShopMetaContext.Provider value={{ currency: shopCurrency, subdivisions }}>
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

      <s-section heading={t("shipping.default_title")}>
        <s-stack direction="block" gap="base">
          <s-text variant="bodySm" tone="subdued">
            {t("shipping.default_desc")}
          </s-text>
          {defaultZone.rates.map((rate) => (
            <RateCard
              key={rate.id}
              rate={rate}
              zoneId={defaultZone.id}
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

      {zones.map((zone) => (
        <ZoneSection key={zone.id} zone={zone} t={t} planInfo={planInfo} />
      ))}

      <s-section heading={t("shipping.add_department")}>
        <createFetcher.Form method="post">
          <input type="hidden" name="_intent" value="create_zone" />
          <s-stack direction="block" gap="small">
            <s-stack direction="inline" gap="base">
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

      <s-section slot="aside" heading={t("shipping.aside_title")}>
        <s-stack direction="block" gap="large">
          <s-stack direction="block" gap="base">
            <s-text variant="headingSm">{t("shipping.shopify_config")}</s-text>
            <s-box padding="base" background="bg-surface-info" borderRadius="large">
              <s-stack direction="block" gap="small">
                <s-text variant="bodySm" fontWeight="semibold">
                  {t("shipping.zone_names_title")}
                </s-text>
                <s-text variant="bodySm">
                  {t("shipping.zone_names_desc")}
                </s-text>
                <s-unordered-list>
                  <s-list-item>
                    <s-text variant="bodySm">{t("shipping.zone_express")}</s-text>
                  </s-list-item>
                  <s-list-item>
                    <s-text variant="bodySm">{t("shipping.zone_envio")}</s-text>
                  </s-list-item>
                  <s-list-item>
                    <s-text variant="bodySm">{t("shipping.zone_other")}</s-text>
                  </s-list-item>
                </s-unordered-list>
                <s-text variant="bodySm" tone="caution">
                  {t("shipping.zone_caution")}
                </s-text>
              </s-stack>
            </s-box>
          </s-stack>

          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", padding: "8px 0" }}>
              <s-text variant="headingSm">{t("shipping.advanced_title")}</s-text>
            </summary>
            <s-stack direction="block" gap="base" paddingBlockStart="base">
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
          </details>

          <s-stack direction="block" gap="base">
            <s-text variant="headingSm">{t("shipping.csv_title")}</s-text>
            <s-text variant="bodySm" tone="subdued">
              {t("shipping.csv_desc")}
            </s-text>
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
            </s-stack>
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
        </s-stack>
      </s-section>
    </s-page>
    </ShopMetaContext.Provider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
