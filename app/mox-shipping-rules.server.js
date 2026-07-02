import { isDeliveryRules } from "./utils/variant";
/**
 * Lógica compartida para reglas de envío por municipio.
 * Usado por:
 *  - Admin UI (CRUD de zonas y tarifas)
 *  - Carrier Service callback (cálculo de tarifas en checkout)
 *  - Sync al metafield de la tienda (para frontend/storefront)
 */

import prisma from "./db.server";
import { resolveCity, normalizeCityForRules, cityMatchesList } from "./utils/city-resolver.server";
import { debug, warn, info, error as logError } from "./utils/logger.server";
import { invalidateProductConditionFields } from "./utils/product-info.server";
import { zoneSlugForCountry, defaultZoneSlugFor } from "./utils/geo";

export { resolveCity };

const DEFAULT_TZ = "America/Bogota";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// --- Slug helper (inlined — no dependency on mox-tags) ---

export function toSlug(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// --- City normalization ---

export function normalizeCity(city) {
  if (!city) return "";
  return city
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "") // Quitar sufijo D.C. (Bogotá D.C. → BOGOTA)
    .replace(/\s+/g, " ")
    .trim();
}

// --- Schedule helpers ---

/**
 * Obtiene la hora y día actual en el timezone de la tienda.
 * Retorna { hour: 14, minute: 30, day: "mon" }
 * @param {string} [tz] — IANA timezone (ej "America/New_York"). Default Bogotá.
 */
function getNowInTz(tz) {
  const now = new Date();
  let localStr;
  try {
    localStr = now.toLocaleString("en-US", { timeZone: tz || DEFAULT_TZ });
  } catch {
    // IANA tz inválido → caer al default para no romper el cálculo de horario.
    localStr = now.toLocaleString("en-US", { timeZone: DEFAULT_TZ });
  }
  const localDate = new Date(localStr);
  return {
    hour: localDate.getHours(),
    minute: localDate.getMinutes(),
    day: DAY_NAMES[localDate.getDay()],
  };
}

/**
 * Verifica si un rate está disponible según su horario.
 * - Si no tiene timeFrom/timeTo → siempre disponible
 * - Si tiene daysOfWeek y hoy no está → no disponible
 * - Si la hora actual está fuera del rango → no disponible
 * @param {string} [tz] — timezone de la tienda para evaluar el horario.
 */
function isWithinSchedule(rate, tz) {
  const { timeFrom, timeTo, daysOfWeek } = rate;

  if (!timeFrom && !timeTo) return true;

  const now = getNowInTz(tz);

  const days = JSON.parse(daysOfWeek || "[]");
  if (days.length > 0 && !days.includes(now.day)) {
    return false;
  }

  const currentMinutes = now.hour * 60 + now.minute;

  if (timeFrom) {
    const [fh, fm] = timeFrom.split(":").map(Number);
    if (currentMinutes < fh * 60 + fm) return false;
  }

  if (timeTo) {
    const [th, tm] = timeTo.split(":").map(Number);
    if (currentMinutes >= th * 60 + tm) return false;
  }

  return true;
}

// --- Product conditions ---

const lowerTrim = (s) => String(s || "").toLowerCase().trim();

/**
 * ¿Este item del carrito matchea los valores configurados para el campo?
 * `item` (cartProduct): { sku, vendor, productType, tags: [], collections: [] }
 * — collections trae handles y títulos; todo se compara case-insensitive.
 */
function itemMatchesProductValues(item, field, values) {
  switch (field) {
    case "vendor":
      return values.includes(lowerTrim(item.vendor));
    case "sku":
      return values.includes(lowerTrim(item.sku));
    case "product_type":
      return values.includes(lowerTrim(item.productType));
    case "collection":
      return (item.collections || []).some((c) => values.includes(lowerTrim(c)));
    case "tags":
    default:
      return (item.tags || []).some((t) => values.includes(lowerTrim(t)));
  }
}

/**
 * Evalúa la condición de producto de una rate contra el carrito.
 *
 * @param {object} rate — ShippingRate (productCondition/productField/productMatchMode/productTags)
 * @param {Array|null} cartProducts — un objeto por item del carrito (ver itemMatchesProductValues)
 * @param {string[]|null} flatItemTags — fallback legacy: tags del carrito aplanadas (callers viejos)
 * @returns {{ applies: boolean, matched?: boolean }} applies=false → la rate se descarta.
 *
 * Sin datos para evaluar (cartProducts y flatItemTags null) → fail open
 * (la condición se ignora), igual que el comportamiento histórico cuando el
 * fetch de tags fallaba.
 */
export function evaluateProductCondition(rate, cartProducts, flatItemTags) {
  if (!rate.productCondition || rate.productCondition === "all") return { applies: true };

  const values = JSON.parse(rate.productTags || "[]").map(lowerTrim).filter(Boolean);
  if (!values.length) return { applies: true };

  const isInclude = rate.productCondition === "include" || rate.productCondition === "include_tags";
  const field = rate.productField || "tags";
  const mode = rate.productMatchMode || "any";

  let matched;
  if (Array.isArray(cartProducts) && cartProducts.length) {
    const flags = cartProducts.map((p) => itemMatchesProductValues(p, field, values));
    matched = mode === "all" ? flags.every(Boolean) : flags.some(Boolean);
  } else if (flatItemTags && field === "tags") {
    // Camino legacy: lista plana de tags sin mapeo por item — solo modo "any".
    matched = values.some((v) => flatItemTags.includes(v));
  } else {
    return { applies: true };
  }

  return { applies: isInclude ? matched : !matched, matched };
}

// --- GraphQL ---

const METAFIELD_SET_MUTATION = `#graphql
  mutation setShippingRulesMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { message field }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation createFletixShippingRulesDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key }
      userErrors { message field code }
    }
  }
`;

// --- Queries ---

export async function getZonesWithRates(shop) {
  return prisma.shippingZone.findMany({
    where: { shop },
    include: { rates: { orderBy: { createdAt: "asc" } } },
    orderBy: { department: "asc" },
  });
}

/**
 * Busca las tarifas aplicables para un destino (departamento + ciudad).
 * Filtra por: enabled + ciudad + horario + tags de productos.
 * Usa el city resolver para manejar errores ortográficos y apodos.
 *
 * @param {string[]} [itemTags] - Tags de los productos en el carrito (todos combinados, sin duplicados).
 *                                 Si no se pasa, se ignora la restricción por tags.
 * @param {{ country?: string, timezone?: string, trace?: object }} [opts] - País del destino
 *        (gatea el catálogo de ciudades CO) y timezone de la tienda (evalúa
 *        horarios). Defaults: CO / America/Bogota. `trace` (opcional, de
 *        createQuoteTrace()) acumula una decisión por regla evaluada para el
 *        quote log — matched + razón de descarte.
 */
export async function getRatesForDestination(shop, departmentSlug, city, department, itemTags, opts = {}) {
  const country = opts.country || "CO";
  const timezone = opts.timezone || DEFAULT_TZ;
  const trace = opts.trace || null;
  // Fuzzy threshold 0..1 (default exact). opts.threshold may arrive as a 0-100
  // percentage from the shop setting, so normalize > 1 down to a ratio.
  const rawThreshold = typeof opts.threshold === "number" ? opts.threshold : 1;
  const threshold = rawThreshold > 1 ? rawThreshold / 100 : rawThreshold;

  const zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug: departmentSlug } },
    include: { rates: { where: { enabled: true } } },
  });

  if (!zone || !zone.enabled) {
    trace?.steps.push({ step: "zone_lookup", slug: departmentSlug, found: !!zone, enabled: zone?.enabled ?? false });
    return [];
  }

  const deptName = department || zone.department;
  const resolved = resolveCity(city, deptName, country);
  const normalizedCity = normalizeCityForRules(city, deptName, country);

  if (resolved.method !== "exact" && resolved.method !== "none") {
    debug(`[city-resolver] "${city}" → "${resolved.resolved}" (${resolved.method}${resolved.distance ? `, dist=${resolved.distance}` : ""})`);
  }

  const normalizedItemTags = itemTags
    ? itemTags.map((t) => t.toLowerCase().trim())
    : null;

  // Honor the zone's enabledServices toggle: rates with a serviceCode the
  // merchant has disabled for this zone (e.g. legacy pickup rate kept after
  // pickup was turned off) must not appear at checkout. Default zone bypasses
  // this filter — it's the catch-all and always offers all 3 methods.
  let enabledServicesForZone = null;
  if (!zone.slug.startsWith(DEFAULT_ZONE_SLUG)) {
    try {
      const parsed = JSON.parse(zone.enabledServices || "[]");
      if (Array.isArray(parsed) && parsed.length > 0) {
        enabledServicesForZone = new Set(parsed);
      }
    } catch {
      // Invalid JSON — fail open (no filter) to avoid hiding rates from a
      // bad column write. Logger noise here would be high-cardinality, so skip.
    }
  }

  // Una entrada de trace por regla evaluada. `reason` queda "ok" provisional
  // para las que pasan — la fase de selección de precio (rate-engine) la
  // sobreescribe con selected / lost_price / tier_gap / method_not_selected.
  const traceRule = (rate, matched, reason, detail) => {
    if (!trace) return;
    trace.rules.push({
      rateId: rate.id,
      name: rate.name,
      serviceCode: rate.serviceCode,
      zone: zone.slug,
      matched,
      reason,
      ...(detail ? { detail } : {}),
    });
  };

  // Origen del checkout resuelto a una bodega (id de Shopify Location), o null
  // si no se pudo resolver / no aplica (ej. simulador sin origen).
  const originWarehouseId = opts.originWarehouseId || null;

  // Primero filtra por TODO menos origen (ciudad, horario, servicio, producto).
  const passed = zone.rates.filter((rate) => {
    if (enabledServicesForZone && !enabledServicesForZone.has(rate.serviceCode)) {
      info(`[rates-filter] ${zone.slug}/${rate.name}(${rate.serviceCode}) DROP enabledServices=[${[...enabledServicesForZone].join(",")}]`);
      traceRule(rate, false, "service_disabled");
      return false;
    }

    if (rate.cityCondition !== "all") {
      const cities = JSON.parse(rate.cities || "[]");
      let aliasMap = {};
      try {
        aliasMap = JSON.parse(rate.cityAliases || "{}") || {};
      } catch {
        // Bad alias JSON — ignore aliases, still match on cities + fuzzy.
      }
      // Fuzzy + alias homologation against the merchant's own city list.
      // `normalizedCity` is the resolved customer city (CO catalog canonicalizes
      // it; other countries pass it through stripped). cityMatchesList strips
      // candidates internally, so pass the raw configured cities.
      const matches = cityMatchesList(normalizedCity, cities, aliasMap, threshold);
      if (rate.cityCondition === "include" && !matches) {
        info(`[rates-filter] ${zone.slug}/${rate.name}(${rate.serviceCode}) DROP city include: input="${normalizedCity}" no match in [${cities.join(",")}] @${threshold} (raw=${rate.cities})`);
        traceRule(rate, false, "city_include", `"${normalizedCity}" no está en [${cities.join(", ")}]`);
        return false;
      }
      if (rate.cityCondition === "exclude" && matches) {
        info(`[rates-filter] ${zone.slug}/${rate.name}(${rate.serviceCode}) DROP city exclude: input="${normalizedCity}" matched [${cities.join(",")}] @${threshold}`);
        traceRule(rate, false, "city_exclude", `"${normalizedCity}" está excluida`);
        return false;
      }
    }

    if (rate.productCondition !== "all") {
      const res = evaluateProductCondition(rate, opts.cartProducts || null, normalizedItemTags);
      if (!res.applies) {
        const isInclude = rate.productCondition === "include" || rate.productCondition === "include_tags";
        const field = rate.productField || "tags";
        const mode = rate.productMatchMode || "any";
        const values = JSON.parse(rate.productTags || "[]");
        info(`[rates-filter] ${zone.slug}/${rate.name}(${rate.serviceCode}) DROP product ${isInclude ? "include" : "exclude"} field=${field} mode=${mode}`);
        traceRule(
          rate,
          false,
          isInclude ? "product_include" : "product_exclude",
          `${field}/${mode}: [${values.join(", ")}]`,
        );
        return false;
      }
    }

    if (!isWithinSchedule(rate, timezone)) {
      info(`[rates-filter] ${zone.slug}/${rate.name}(${rate.serviceCode}) DROP schedule`);
      traceRule(rate, false, "schedule", `fuera de ${rate.timeFrom || "?"}-${rate.timeTo || "?"}`);
      return false;
    }

    // Marca el reason según el scope por origen, pero SIEMPRE incluye la rate
    // en `passed` (la separación real la hace el fallback de abajo).
    const originDrops = originWarehouseId && rate.warehouseId && rate.warehouseId !== originWarehouseId;
    traceRule(rate, !originDrops, originDrops ? "origin_mismatch" : "ok");
    return true;
  });

  // Scope por origen (Parcelify-style) con FALLBACK SEGURO:
  //  - warehouseId null  → la rate aplica a cualquier origen.
  //  - origen no resuelto → no se filtra (se muestra de más).
  //  - si el scope por origen vaciaría el resultado pero SIN él habría rates,
  //    se devuelven sin filtrar para no romper el checkout ("no delivery").
  if (!originWarehouseId) return passed;
  const scoped = passed.filter((r) => !r.warehouseId || r.warehouseId === originWarehouseId);
  if (scoped.length === 0 && passed.length > 0) {
    info(`[rates-filter] ${zone.slug} origin=${originWarehouseId} dejaría 0 rates — fallback a sin filtrar (${passed.length})`);
    trace?.steps.push({ step: "origin_fallback", originWarehouseId, kept: passed.length });
    return passed;
  }
  return scoped;
}

// --- CRUD ---

const DEFAULT_ZONE_SLUG = "_default";
const DEFAULT_ZONE_NAME = "Tarifa por defecto";

/**
 * Retorna el Set de serviceCodes que la zona del depto define (al menos una rate habilitada).
 * Usado por el carrier service para decidir el fallback a _default por serviceCode:
 *   - Si el código está en el set → la zona es autoritativa para ese método (sin _default).
 *   - Si el código NO está en el set → _default llena el hueco para ese método.
 *   - Si no hay zona → retorna Set vacío, todos los métodos caen a _default.
 */
export async function getZoneDefinedServiceCodes(shop, departmentSlug) {
  const empty = new Set();
  if (!departmentSlug || departmentSlug === DEFAULT_ZONE_SLUG) return empty;
  const zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug: departmentSlug } },
    include: { rates: { where: { enabled: true }, select: { serviceCode: true } } },
  });
  if (!zone || !zone.enabled) return empty;

  let enabledServicesForZone = null;
  try {
    const parsed = JSON.parse(zone.enabledServices || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) {
      enabledServicesForZone = new Set(parsed);
    }
  } catch {
    // Fail open — see getRatesForDestination.
  }

  return new Set(
    zone.rates
      .filter((r) => !enabledServicesForZone || enabledServicesForZone.has(r.serviceCode))
      .map((r) => r.serviceCode),
  );
}

export async function getOrCreateDefaultZone(shop, country = "CO") {
  let zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug: DEFAULT_ZONE_SLUG } },
    include: { rates: { orderBy: { createdAt: "asc" } } },
  });

  if (!zone) {
    zone = await prisma.shippingZone.create({
      data: { shop, department: DEFAULT_ZONE_NAME, slug: DEFAULT_ZONE_SLUG, country },
      include: { rates: true },
    });
  }

  return zone;
}

/**
 * Default por país: `_default` (legacy) para el país de la tienda,
 * `_default_{cc}` para los demás. El checkout solo usa el default del país
 * destino — un destino sin default propio no hereda el de otro país.
 */
export async function getOrCreateDefaultZoneForCountry(shop, country, shopCountry) {
  const slug = defaultZoneSlugFor(country, shopCountry);
  if (slug === DEFAULT_ZONE_SLUG) return getOrCreateDefaultZone(shop, country);

  let zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug } },
    include: { rates: { orderBy: { createdAt: "asc" } } },
  });

  if (!zone) {
    zone = await prisma.shippingZone.create({
      data: { shop, department: `${DEFAULT_ZONE_NAME} (${country})`, slug, country },
      include: { rates: true },
    });
  }

  return zone;
}

/**
 * De una lista de slugs candidatos (prefijado primero, legacy después),
 * retorna el primero que exista como zona de la tienda. Si ninguno existe,
 * retorna el primero (el lookup posterior no encontrará zona → aplica default).
 */
export async function resolveExistingZoneSlug(shop, candidateSlugs) {
  if (!candidateSlugs?.length) return null;
  if (candidateSlugs.length === 1) return candidateSlugs[0];
  const zones = await prisma.shippingZone.findMany({
    where: { shop, slug: { in: candidateSlugs } },
    select: { slug: true },
  });
  const found = new Set(zones.map((z) => z.slug));
  for (const slug of candidateSlugs) {
    if (found.has(slug)) return slug;
  }
  return candidateSlugs[0];
}

/**
 * Crea una zona. `department` debe ser el NOMBRE de la subdivisión (ej
 * "Antioquia", "Jalisco"); el slug se deriva de él con prefijo de país para
 * países distintos de CO ("mx_jalisco") y debe coincidir con los candidatos
 * de `provinceToZoneSlugCandidates(country, código)` que usa el checkout.
 */
export async function createZone(shop, department, enabledServices, country = "CO") {
  const slug = zoneSlugForCountry(country, department);
  const data = { shop, department, slug, country };
  if (Array.isArray(enabledServices) && enabledServices.length > 0) {
    data.enabledServices = JSON.stringify(enabledServices);
  }
  return prisma.shippingZone.create({ data });
}

/**
 * Duplica una zona hacia OTRO departamento: get-or-create la zona destino
 * (mismo país que la origen) y copia todas sus tarifas con sus condiciones.
 * La zona destino conserva sus tarifas existentes (las copiadas se suman).
 * Retorna { zone, ratesCopied, zoneCreated }.
 */
export async function duplicateZoneTo(shop, sourceZoneId, targetDepartment) {
  const source = await prisma.shippingZone.findFirst({
    where: { id: sourceZoneId, shop },
    include: { rates: true },
  });
  if (!source) throw new Error("Zone not found or unauthorized");
  const country = source.country || "CO";
  const slug = zoneSlugForCountry(country, targetDepartment);
  if (slug === source.slug) throw new Error("Target department equals source");

  let zone = await prisma.shippingZone.findUnique({ where: { shop_slug: { shop, slug } } });
  const zoneCreated = !zone;
  if (!zone) {
    zone = await prisma.shippingZone.create({
      data: {
        shop,
        department: targetDepartment,
        slug,
        country,
        enabledServices: source.enabledServices,
      },
    });
  }

  let ratesCopied = 0;
  for (const rate of source.rates) {
    const { id: _id, createdAt: _c, updatedAt: _u, zoneId: _z, ...fields } = rate;
    await prisma.shippingRate.create({ data: { ...fields, zone: { connect: { id: zone.id } } } });
    ratesCopied++;
  }
  invalidateProductConditionFields(shop);
  return { zone, ratesCopied, zoneCreated };
}

export async function updateZoneEnabledServices(shop, zoneId, enabledServices) {
  if (!Array.isArray(enabledServices) || enabledServices.length === 0) {
    throw new Error("enabledServices must be a non-empty array");
  }
  const zone = await prisma.shippingZone.findFirst({ where: { id: zoneId, shop } });
  if (!zone) throw new Error("Zone not found or unauthorized");
  return prisma.shippingZone.update({
    where: { id: zoneId },
    data: { enabledServices: JSON.stringify(enabledServices) },
  });
}

export async function deleteZone(id, shop) {
  const zone = await prisma.shippingZone.findFirst({ where: { id, shop } });
  if (!zone) throw new Error("Zone not found or unauthorized");
  const deleted = await prisma.shippingZone.delete({ where: { id } });
  // El delete cascadea a las rates de la zona — el set de campos de producto
  // usados puede haber cambiado.
  invalidateProductConditionFields(shop);
  return deleted;
}

export async function saveRate({
  id,
  zoneId,
  shop,
  name,
  serviceCode,
  price,
  description,
  cityCondition,
  cities,
  cityAliases,
  timeFrom,
  timeTo,
  daysOfWeek,
  pricingMode,
  weightTiers,
  cartTotalTiers,
  productCondition,
  productField,
  productMatchMode,
  productTags,
  minDeliveryDays,
  maxDeliveryDays,
  warehouseId,
  perItemPrice,
}) {
  // Normaliza valores legacy hacia el modelo nuevo al guardar: el runtime
  // sigue aceptando include_tags/exclude_tags para filas viejas no re-guardadas.
  let normalizedProductCondition = productCondition || "all";
  let normalizedProductField = productField || "tags";
  if (normalizedProductCondition === "include_tags") {
    normalizedProductCondition = "include";
    normalizedProductField = "tags";
  } else if (normalizedProductCondition === "exclude_tags") {
    normalizedProductCondition = "exclude";
    normalizedProductField = "tags";
  }
  const VALID_FIELDS = new Set(["tags", "vendor", "product_type", "collection", "sku"]);
  if (!VALID_FIELDS.has(normalizedProductField)) normalizedProductField = "tags";
  const normalizedMatchMode = productMatchMode === "all" ? "all" : "any";
  // parseFloat (not parseInt): prices are in major currency units and may have
  // minor units for non-zero-decimal currencies (USD 12.99). Clamp a >= 0 —
  // un precio negativo llegaría tal cual al checkout de Shopify (comportamiento
  // indefinido) y no hay caso de uso legítimo; gratis = 0.
  const parsedPrice = Math.max(0, parseFloat(price) || 0);

  // Mismo clamp para los precios dentro de los tiers (UI y CSV los mandan
  // como JSON ya armado).
  const clampTierPrices = (json) => {
    try {
      const tiers = JSON.parse(json || "[]");
      if (!Array.isArray(tiers)) return "[]";
      for (const tier of tiers) {
        tier.price = Math.max(0, Number(tier.price) || 0);
      }
      return JSON.stringify(tiers);
    } catch {
      return "[]";
    }
  };

  // Días calendario, enteros >= 0. Cualquier valor inválido o vacío → null
  // (sin estimado). Si solo viene uno de los dos, se duplica al otro para que
  // el checkout siempre reciba un rango coherente.
  const parseDays = (v) => {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  let minDays = parseDays(minDeliveryDays);
  let maxDays = parseDays(maxDeliveryDays);
  if (minDays !== null && maxDays === null) maxDays = minDays;
  if (maxDays !== null && minDays === null) minDays = maxDays;
  if (minDays !== null && maxDays !== null && maxDays < minDays) {
    [minDays, maxDays] = [maxDays, minDays];
  }

  const fields = {
    name,
    serviceCode,
    price: parsedPrice,
    description: description || "",
    cityCondition: cityCondition || "all",
    cities: cities || "[]",
    cityAliases: cityAliases || "{}",
    timeFrom: timeFrom || null,
    timeTo: timeTo || null,
    daysOfWeek: daysOfWeek || "[]",
    pricingMode: pricingMode || "flat",
    weightTiers: clampTierPrices(weightTiers),
    cartTotalTiers: clampTierPrices(cartTotalTiers),
    productCondition: normalizedProductCondition,
    productField: normalizedProductField,
    productMatchMode: normalizedMatchMode,
    productTags: productTags || "[]",
    minDeliveryDays: minDays,
    maxDeliveryDays: maxDays,
    // "" o ausente → null = bodega derivada por ubicación (no override).
    warehouseId: warehouseId ? String(warehouseId) : null,
    // Modo per_item: precio por cada ítem adicional (>= 0).
    perItemPrice: Math.max(0, parseFloat(perItemPrice) || 0),
  };

  if (id) {
    const existing = await prisma.shippingRate.findFirst({
      where: { id, zone: { shop } },
    });
    if (!existing) throw new Error("Rate not found or unauthorized");
    const updated = await prisma.shippingRate.update({ where: { id }, data: fields });
    if (shop) invalidateProductConditionFields(shop);
    return updated;
  }

  if (shop) {
    const zone = await prisma.shippingZone.findFirst({ where: { id: zoneId, shop } });
    if (!zone) throw new Error("Zone not found or unauthorized");
  }

  const created = await prisma.shippingRate.create({
    data: {
      ...fields,
      zone: { connect: { id: zoneId } },
    },
  });
  if (shop) invalidateProductConditionFields(shop);
  return created;
}

/**
 * Duplica una tarifa dentro de su misma zona, copiando todas las condiciones.
 * `nameSuffix` se agrega al nombre (ej " (copia)") — el caller lo localiza.
 */
export async function duplicateRate(id, shop, nameSuffix) {
  const rate = await prisma.shippingRate.findFirst({
    where: { id, zone: { shop } },
  });
  if (!rate) throw new Error("Rate not found or unauthorized");

  const { id: _id, createdAt: _c, updatedAt: _u, zoneId, name, ...fields } = rate;
  const created = await prisma.shippingRate.create({
    data: {
      ...fields,
      name: `${name}${nameSuffix || " (copy)"}`,
      zone: { connect: { id: zoneId } },
    },
  });
  invalidateProductConditionFields(shop);
  return created;
}

export async function deleteRate(id, shop) {
  const rate = await prisma.shippingRate.findFirst({
    where: { id, zone: { shop } },
  });
  if (!rate) throw new Error("Rate not found or unauthorized");
  const deleted = await prisma.shippingRate.delete({ where: { id } });
  invalidateProductConditionFields(shop);
  return deleted;
}

// --- Sync to shop metafield ---

/**
 * Namespace canónico de Fletix. El storefront debe leer desde acá.
 * El namespace `mox_store_promise` se sigue escribiendo transitoriamente para no
 * romper instalaciones del theme que aún no migraron — ver TODO-NAMESPACE-MIGRATION.md.
 */
const FLETIX_NAMESPACE = "fletix";
const LEGACY_NAMESPACE = "mox_store_promise";
const METAFIELD_KEY = "shipping_rules";

/**
 * Registra la metafield definition de `fletix.shipping_rules` con
 * acceso público de storefront. Idempotente: ignora el error si ya existe.
 *
 * Esto permite que cualquier theme (incluyendo el de mox-store-promise) lea
 * `shop.metafields.fletix.shipping_rules` desde Liquid, y que el merchant vea
 * el metafield en Settings → Custom data del admin con descripción.
 */
async function ensureFletixMetafieldDefinition(admin) {
  const brandName =
    isDeliveryRules(process.env.APP_VARIANT) ? "Delivery Rules" : "Fletix";
  try {
    const res = await admin.graphql(METAFIELD_DEFINITION_CREATE_MUTATION, {
      variables: {
        definition: {
          namespace: FLETIX_NAMESPACE,
          key: METAFIELD_KEY,
          name: `${brandName} Shipping Rules`,
          description: `Reglas de envío publicadas por ${brandName} para consumo de temas.`,
          type: "json",
          ownerType: "SHOP",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    });
    const data = await res.json();
    const errors = data.data?.metafieldDefinitionCreate?.userErrors || [];
    // TAKEN_BY_OTHER significa que ya existe — esperado en deploys subsecuentes.
    const realErrors = errors.filter((e) => e.code !== "TAKEN" && e.code !== "TAKEN_BY_OTHER");
    if (realErrors.length > 0) {
      warn("[shipping-rules] metafieldDefinitionCreate errors:", realErrors);
    }
  } catch (err) {
    // No bloqueante: el sync del metafield puede continuar aún sin la definition.
    warn("[shipping-rules] No se pudo crear metafield definition:", err?.message || err);
  }
}

/**
 * Serializa reglas a JSON y las publica al metafield del shop.
 *
 * Escribe al namespace canónico `fletix.shipping_rules` y simultáneamente al
 * legacy `mox_store_promise.shipping_rules` para retrocompatibilidad con el
 * theme de mox-store-promise mientras se migra a leer del namespace nuevo.
 *
 * Plan de remoción del legacy: una vez que todos los themes consumidores
 * lean exclusivamente de `fletix.shipping_rules`, eliminar la entrada legacy
 * del array de metafields y borrar el metafield viejo de la tienda.
 */
export async function syncRulesToMetafield(admin, shop) {
  await ensureFletixMetafieldDefinition(admin);

  const zones = await getZonesWithRates(shop);
  const rules = {};

  for (const zone of zones) {
    if (!zone.enabled) continue;
    rules[zone.slug] = {};

    let enabledServicesForZone = null;
    if (!zone.slug.startsWith(DEFAULT_ZONE_SLUG)) {
      try {
        const parsed = JSON.parse(zone.enabledServices || "[]");
        if (Array.isArray(parsed) && parsed.length > 0) {
          enabledServicesForZone = new Set(parsed);
        }
      } catch {
        // Fail open.
      }
    }

    for (const rate of zone.rates) {
      if (!rate.enabled) continue;
      if (enabledServicesForZone && !enabledServicesForZone.has(rate.serviceCode)) continue;
      const cities = JSON.parse(rate.cities || "[]").map(normalizeCity);
      const rule = {
        condition: rate.cityCondition,
        cities,
      };

      if (rate.productCondition !== "all") {
        rule.productCondition = rate.productCondition;
        rule.productField = rate.productField || "tags";
        rule.productMatchMode = rate.productMatchMode || "any";
        rule.productTags = JSON.parse(rate.productTags || "[]");
      }

      if (rate.timeFrom) rule.timeFrom = rate.timeFrom;
      if (rate.timeTo) rule.timeTo = rate.timeTo;
      if (rate.minDeliveryDays != null) rule.minDeliveryDays = rate.minDeliveryDays;
      if (rate.maxDeliveryDays != null) rule.maxDeliveryDays = rate.maxDeliveryDays;
      const days = JSON.parse(rate.daysOfWeek || "[]");
      if (days.length > 0) rule.days = days;

      if (!rules[zone.slug][rate.serviceCode]) {
        rules[zone.slug][rate.serviceCode] = [];
      }
      rules[zone.slug][rate.serviceCode].push(rule);
    }
  }

  const json = JSON.stringify(rules);
  const ownerId = `gid://shopify/Shop/${await getShopId(admin)}`;

  const res = await admin.graphql(METAFIELD_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace: FLETIX_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: json,
        },
        {
          ownerId,
          namespace: LEGACY_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: json,
        },
      ],
    },
  });

  const data = await res.json();
  const errors = data.data?.metafieldsSet?.userErrors || [];
  if (errors.length > 0) {
    logError("[shipping-rules] Metafield errors:", errors);
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  debug(`[shipping-rules] Synced ${Object.keys(rules).length} zones to metafield (fletix + legacy)`);
  return rules;
}

// --- Helpers ---

async function getShopId(admin) {
  const res = await admin.graphql(`query { shop { id } }`);
  const data = await res.json();
  return data.data.shop.id.replace("gid://shopify/Shop/", "");
}
